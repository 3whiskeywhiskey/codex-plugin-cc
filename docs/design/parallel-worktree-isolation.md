# Design: Parallel-Safe Worktree Isolation

Status: Proposal
Target version: 1.1.x
Author: community proposal

## Summary

Today the Codex plugin keys all shared state — the job ledger (`state.json`)
and the long-lived app-server **broker** — by the *workspace root path* alone.
Every Claude Code session, and every concurrent job within a session, that runs
in the same working directory contends on those two shared singletons. The
contention is unguarded: the job ledger is a read-modify-write of one file with
no lock, and the broker is a per-workspace process that any session can tear
down.

This document proposes a refactor that makes an **isolation key** the unit of
sharing instead of the bare workspace path, with git worktrees as the natural
isolation primitive, plus the locking/atomicity fixes required to make the
shared ledger safe when isolation cannot be guaranteed. The goal is to let the
plugin be driven as a *parallel workflow target* — many concurrent Codex jobs —
without lost job records, deleted log files, or cross-session broker teardown.

## Background: how sharing works today

State directory keying (`plugins/codex/scripts/lib/state.mjs:29-44`):

```js
export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  // canonicalize via realpath, then:
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const stateRoot = process.env.CLAUDE_PLUGIN_DATA
    ? path.join(process.env.CLAUDE_PLUGIN_DATA, "state")
    : path.join(os.tmpdir(), "codex-companion");
  return path.join(stateRoot, `${slug}-${hash}`);
}
```

Everything hangs off `resolveStateDir`:

- `state.json` — the job ledger (`state.mjs:46-48`)
- `jobs/<id>.json`, `jobs/<id>.log` — per-job records and logs (`state.mjs:50-52`)
- `broker.json` — the broker endpoint descriptor (`broker-lifecycle.mjs:72-74`)

The broker is one process per workspace. The first Codex call in a workspace
spawns a `codex app-server` and a broker that listens on a Unix domain socket
(named pipe on Windows) and **serializes to exactly one active turn at a time**
(`app-server-broker.mjs:170-182`). A second concurrent request is rejected with
`BROKER_BUSY`; the caller then falls back to spawning its own direct
`codex app-server` (`codex.mjs:616-631`).

Jobs are tagged with `CODEX_COMPANION_SESSION_ID` and filtered per session in
the status/cancel/result paths (`job-control.mjs:19-25`), so sessions are
*logically* separated — but they physically share the one unlocked `state.json`
and the one broker.

## Problems

The following are concrete races, each made worse by parallelism. File
references point at the current behavior.

### P1 — Unlocked read-modify-write on the job ledger

`saveState` is `load → mutate → write` with no lock
(`state.mjs:92-122`, via `updateState`/`upsertJob`). Two jobs updating progress
or completion concurrently interleave as last-write-wins, silently dropping the
other's record. Every job start, every progress phase change
(`tracked-jobs.mjs:102`), and every completion writes the whole file.

### P2 — Stale-snapshot file deletion

`saveState` prunes the ledger to `MAX_JOBS = 50` and then **deletes the
`jobs/<id>.json` and `<id>.log` files** for any job not in the retained set,
where the retained set is computed from a possibly-stale in-memory snapshot
(`state.mjs:80-112`). Under concurrency this can delete the job and log files of
a *sibling job that is still running*, because the deleting process never saw
the sibling's record.

### P3 — Workspace-global broker teardown on SessionEnd

`SessionEnd` sends `broker/shutdown` and tears down the broker
(`session-lifecycle-hook.mjs:81-110`). The broker is shared across *all*
sessions in the workspace, so ending one session kills the broker other live
sessions are using. They recover via the direct-spawn fallback, but in-flight
turns break and the recovery is churny.

### P4 — Cross-session ledger mutation on SessionEnd

`cleanupSessionJobs` does another unlocked `load → filter → saveState`
(`session-lifecycle-hook.mjs:41-74`), compounding P1/P2 at teardown time.

### P5 — Broker serialization defeats its own purpose under load

The broker exists to multiplex a single `codex app-server`. When N jobs run
concurrently, N-1 of them bypass it and spawn their own app-servers
(`codex.mjs:629`). This is functionally fine but means "parallel" is an
unmanaged fallback path, not a designed lane — there is no backpressure, no
queueing, and no shared rate awareness across the spawned app-servers.

### Severity

| Problem | Impact | Trigger |
|---|---|---|
| P1 | Lost job records | Two concurrent jobs, same state dir |
| P2 | Deleted files of a running job | >`MAX_JOBS` churn or concurrent prune |
| P3 | Broken in-flight turns in sibling sessions | One session ends while another runs |
| P4 | Lost records at teardown | SessionEnd during concurrent activity |
| P5 | No backpressure; rate-limit storms | Many parallel jobs |

P1–P4 only occur when the **state dir is shared**, i.e. same canonical
workspace path. That is the lever this design pulls.

## Goals / non-goals

Goals:

1. Concurrent Codex jobs in distinct git worktrees never share state or a broker.
2. Concurrent jobs that *do* share a state dir cannot lose records or delete a
   running sibling's files.
3. SessionEnd never tears down state or a broker belonging to another live
   session.
4. Back-compatible default: a single interactive session in a single repo
   behaves exactly as today (one broker, one ledger).
5. No new runtime dependencies. The plugin ships zero production npm deps
   (`package.json` has only devDeps); keep it that way — implement locking with
   Node built-ins.

Non-goals:

- A cross-process scheduler / global rate limiter for Codex calls (P5 mitigation
  is left as a follow-up; see Alternatives).
- Changing the broker's one-turn-at-a-time semantics *within* an isolation unit.
- Multi-machine coordination.

## Design

### D1 — Isolation key as the unit of sharing

Introduce an explicit **isolation key** that replaces "bare workspace path" as
the hashed input to `resolveStateDir` and the broker key. Resolution order:

1. `CODEX_COMPANION_ISOLATION_KEY` (explicit override; set by orchestrators).
2. Git worktree root, if `cwd` is inside a git worktree:
   `git rev-parse --show-toplevel` resolved through the worktree's own
   `.git` — distinct linked worktrees already resolve to distinct toplevels, so
   this gives per-worktree isolation for free.
3. Canonical `cwd` workspace root (today's behavior) as the fallback.

```js
// state.mjs (sketch)
export function resolveIsolationKey(cwd) {
  const explicit = process.env.CODEX_COMPANION_ISOLATION_KEY;
  if (explicit && explicit.trim()) return explicit.trim();
  const worktreeRoot = tryGitWorktreeRoot(cwd); // git rev-parse --show-toplevel
  if (worktreeRoot) return canonical(worktreeRoot);
  return canonical(resolveWorkspaceRoot(cwd));
}

export function resolveStateDir(cwd) {
  const key = resolveIsolationKey(cwd);
  const slug = slugify(path.basename(key) || "workspace");
  const hash = sha256(key).slice(0, 16);
  return path.join(stateRoot(), `${slug}-${hash}`);
}
```

Because distinct git worktrees have distinct toplevels, a Workflow that fans out
with `isolation: 'worktree'` gets a separate state dir **and** a separate broker
per agent with no further work — eliminating P1–P4 by construction for the
common parallel case. The explicit env override covers non-git or
same-directory parallelism (e.g. ephemeral sandboxes that share a path).

### D2 — Optional per-session isolation mode

For users who run multiple interactive Claude Code sessions in the *same*
worktree and want them fully independent, support folding the session id into
the isolation key:

- `CODEX_COMPANION_ISOLATION = worktree | session` (default `worktree`).
- In `session` mode, the key becomes `${worktreeRoot}\0${SESSION_ID}`.

`session` mode trades the shared-broker benefit (one app-server reused across a
session's jobs) for total isolation. `worktree` mode (default) keeps today's
single-broker-per-worktree behavior but relies on D3 to make the shared ledger
safe.

### D3 — Atomic, locked ledger writes

Even within one isolation unit, a session can have multiple concurrent jobs
(status updates + completions). Make the ledger safe regardless of isolation:

1. **Atomic write.** Write `state.json` to `state.json.tmp.<pid>.<rand>` then
   `fs.renameSync` over the target. Rename is atomic on the same filesystem, so
   readers never see a half-written file. (Today `writeFileSync` can interleave
   a torn read; `state.mjs:114`.)

2. **Advisory lock around read-modify-write.** Wrap `updateState` /
   `saveState` / `cleanupSessionJobs` in a lock acquired via `O_CREAT|O_EXCL` on
   `state.lock` (a sentinel file), with bounded spin-retry + stale-lock breaking
   (ignore a lock whose mtime is older than, say, 30s). No dependency required —
   `fs.openSync(lockPath, "wx")` is the primitive. Pattern:

   ```js
   function withStateLock(stateDir, fn) {
     const lock = path.join(stateDir, "state.lock");
     acquire(lock); // wx open, retry w/ backoff, break if stale
     try { return fn(); } finally { release(lock); }
   }
   ```

3. **Move pruning under the lock and re-read first.** `pruneJobs` and the
   subsequent file deletion (`state.mjs:80-112`) must run on the freshly locked
   read, never a stale snapshot — this closes P2. Additionally, **never delete
   the files of a job whose status is `queued` or `running`**, regardless of the
   prune window, as a belt-and-suspenders guard.

### D4 — Session-scoped teardown

Fix SessionEnd (`session-lifecycle-hook.mjs:81-110`) so it never destroys shared
resources another session needs:

- **Broker:** only `broker/shutdown` + teardown when this session is the last
  user of the broker. Maintain a refcount or a `sessions` set in `broker.json`
  (written under the same lock as D3). On SessionEnd, remove this session from
  the set; only tear down when the set is empty. In `session` isolation mode the
  broker is already private, so teardown is unconditional and correct.
- **Ledger:** `cleanupSessionJobs` runs under the D3 lock and only removes rows
  whose `sessionId` matches — it already filters by session
  (`session-lifecycle-hook.mjs:53,72`), so the only change is locking + atomic
  write. Terminate only this session's `queued|running` job process trees
  (already the case, `:58-68`).

### D5 — Document the parallel workflow contract

Add a short "Parallel / orchestrated use" section to the README describing the
supported shape:

- One isolation unit per concurrent worker — either a distinct git worktree
  (preferred) or a distinct `CODEX_COMPANION_ISOLATION_KEY`.
- Pass a distinct `CODEX_COMPANION_SESSION_ID` per worker so status/cancel/result
  stay scoped.
- Expect one real `codex app-server` + one model call per concurrent job;
  OpenAI-side rate limits, not this plugin, are the binding constraint.

## Implementation plan

Phased so each step is independently shippable and testable.

1. **D3 first (safety, no behavior change).** Add `withStateLock`, atomic
   rename, and lock-scoped pruning with the running-job deletion guard. This
   alone removes P1, P2, P4 for *all* current users with no API surface change.
   Pure addition behind the existing functions.
2. **D1 isolation key.** Refactor `resolveStateDir` to go through
   `resolveIsolationKey`; add `tryGitWorktreeRoot` and the
   `CODEX_COMPANION_ISOLATION_KEY` override. Default path (no git, no env)
   reproduces today's hash input, so existing state dirs are unaffected for
   non-worktree users.
3. **D4 broker refcount.** Add the `sessions` set to `broker.json` and make
   SessionEnd teardown conditional. Removes P3.
4. **D2 session mode + D5 docs.** Opt-in `CODEX_COMPANION_ISOLATION=session`
   and the README contract.

Steps 1 and 2 are the high-value core; 3 and 4 harden the multi-session-same-
worktree case.

## Backward compatibility

- Default behavior for a single interactive session in a plain git repo:
  identical broker + ledger semantics (one isolation unit = the worktree root,
  which for a normal checkout is the repo root).
- State directory location is unchanged for non-worktree, non-override users
  (the hashed input is still the canonical workspace path in the fallback
  branch). Worktree users will get a *new* state dir keyed by the worktree
  toplevel — acceptable, since prior runs in a linked worktree were already
  colliding on the main repo's dir and that is the bug being fixed. Note this
  one-time migration in the changelog.
- No new runtime dependencies; locking uses `fs` primitives only.

## Testing

- **Concurrency test for D3:** spawn N child processes that each `upsertJob` +
  `saveState` against a shared temp state dir in a tight loop; assert no record
  is lost and no `running` job's files are deleted. Extends
  `tests/state.test.mjs`.
- **Isolation key test for D1:** create a git repo with a linked worktree
  (`git worktree add`), assert `resolveStateDir` differs between the main and
  linked worktree and matches `CODEX_COMPANION_ISOLATION_KEY` when set.
- **Broker refcount test for D4:** simulate two sessions joining the broker;
  assert teardown only fires when the second leaves. Extends
  `tests/broker-endpoint.test.mjs`.
- **Stale-lock test:** assert an abandoned `state.lock` older than the threshold
  is broken and acquisition proceeds.

## Alternatives considered

- **Lockfile via a dependency (`proper-lockfile`).** Rejected: violates the
  zero-runtime-dependency posture that currently makes the plugin low-risk to
  ship and audit. The `O_EXCL` sentinel is sufficient for single-machine use.
- **SQLite ledger.** Rejected for the same dependency reason and because the
  job ledger is small (`MAX_JOBS = 50`) and append-light; a locked JSON file is
  adequate.
- **Per-job app-server, drop the broker entirely.** Simpler concurrency story
  (no shared broker → no P3/P5), but loses the reuse benefit for the common
  single-session, many-small-jobs case and increases cold-start cost. The
  isolation-key approach keeps the broker where it helps and removes it where it
  hurts.
- **Global cross-process Codex rate limiter (P5).** Out of scope here; would be
  a separate semaphore (file-locked counter or a coordinating broker that
  *queues* rather than rejects on busy). Worth a follow-up once parallel use is
  common, but it is an optimization, not a correctness fix.

## Open questions

- Stale-lock threshold: fixed (e.g. 30s) vs. derived from the longest expected
  ledger write. A fixed small value is probably fine since writes are tiny.
- Should `worktree` mode also fold a short hash of the *main* repo path to avoid
  collisions between identically-named worktrees of different repos? The
  toplevel path already disambiguates, but the slug does not — only the hash
  does, which is fine.
- Whether to expose `/codex:status --all-sessions` to inspect across isolation
  units for debugging, now that isolation is stronger.
