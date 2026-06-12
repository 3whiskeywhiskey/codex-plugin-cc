import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import {
  resolveIsolationKey,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  resolveStateFile,
  saveState,
  upsertJob,
  withStateLock
} from "../plugins/codex/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE_MODULE_URL = pathToFileURL(path.join(ROOT, "plugins", "codex", "scripts", "lib", "state.mjs")).href;

function withEnv(overrides, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);

  assert.equal(stateDir.startsWith(os.tmpdir()), true);
  assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(
      stateDir,
      new RegExp(`^${path.join(pluginDataDir, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("resolveStateDir can be isolated with an explicit key", () => {
  const workspace = makeTempDir();

  const first = withEnv({ CODEX_COMPANION_ISOLATION_KEY: "worker-a" }, () => resolveStateDir(workspace));
  const second = withEnv({ CODEX_COMPANION_ISOLATION_KEY: "worker-b" }, () => resolveStateDir(workspace));
  const firstAgain = withEnv({ CODEX_COMPANION_ISOLATION_KEY: "worker-a" }, () => resolveStateDir(workspace));

  assert.notEqual(first, second);
  assert.equal(first, firstAgain);
  assert.equal(
    withEnv(
      {
        CODEX_COMPANION_ISOLATION_KEY: null,
        CODEX_COMPANION_ISOLATION: null,
        CODEX_COMPANION_SESSION_ID: null
      },
      () => resolveIsolationKey(workspace)
    ),
    fs.realpathSync.native(workspace)
  );
});

test("resolveStateDir separates linked git worktrees", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n", "utf8");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const linked = path.join(makeTempDir(), "linked");
  const added = run("git", ["worktree", "add", linked, "-b", "test-linked"], { cwd: repo });
  assert.equal(added.status, 0, added.stderr);

  try {
    assert.notEqual(resolveStateDir(repo), resolveStateDir(linked));
  } finally {
    run("git", ["worktree", "remove", "--force", linked], { cwd: repo });
  }
});

test("resolveStateDir supports session isolation mode", () => {
  const workspace = makeTempDir();

  const first = withEnv(
    {
      CODEX_COMPANION_ISOLATION: "session",
      CODEX_COMPANION_SESSION_ID: "sess-a"
    },
    () => resolveStateDir(workspace)
  );
  const second = withEnv(
    {
      CODEX_COMPANION_ISOLATION: "session",
      CODEX_COMPANION_SESSION_ID: "sess-b"
    },
    () => resolveStateDir(workspace)
  );

  assert.notEqual(first, second);
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const prunedLogFile = resolveJobLogFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});

test("saveState does not delete active job artifacts from a stale snapshot", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const runningLogFile = resolveJobLogFile(workspace, "job-running");
  const runningJobFile = resolveJobFile(workspace, "job-running");
  fs.writeFileSync(runningLogFile, "running\n", "utf8");
  fs.writeFileSync(runningJobFile, JSON.stringify({ id: "job-running", status: "running" }, null, 2), "utf8");

  const jobs = [
    {
      id: "job-running",
      status: "running",
      logFile: runningLogFile,
      updatedAt: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z"
    }
  ];
  for (let index = 0; index < 51; index += 1) {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index + 1, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    jobs.push({
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    });
  }

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs }, null, 2)}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: jobs.filter((job) => job.id !== "job-running")
  });

  assert.equal(fs.existsSync(runningJobFile), true);
  assert.equal(fs.existsSync(runningLogFile), true);
});

test("withStateLock breaks stale locks", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(stateDir, { recursive: true });
  const lockFile = path.join(stateDir, "state.lock");
  fs.writeFileSync(lockFile, "stale\n", "utf8");
  const staleTime = new Date(Date.now() - 60_000);
  fs.utimesSync(lockFile, staleTime, staleTime);

  const result = withStateLock(workspace, () => "locked");

  assert.equal(result, "locked");
  assert.equal(fs.existsSync(lockFile), false);
});

test("concurrent upsertJob calls keep every job record", async () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const childSource = `
    const { upsertJob } = await import(${JSON.stringify(STATE_MODULE_URL)});
    const workspace = process.argv[1];
    const worker = process.argv[2];
    for (let index = 0; index < 12; index += 1) {
      upsertJob(workspace, {
        id: \`job-\${worker}-\${index}\`,
        status: "completed",
        summary: \`worker \${worker} job \${index}\`
      });
    }
  `;

  await Promise.all(
    Array.from({ length: 4 }, (_, index) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", childSource, workspace, String(index)], {
          cwd: ROOT,
          env: {
            ...process.env,
            CLAUDE_PLUGIN_DATA: pluginDataDir
          },
          stdio: ["ignore", "pipe", "pipe"]
        });
        let stderr = "";
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("error", reject);
        child.on("exit", (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(stderr || `child exited ${code}`));
          }
        });
      })
    )
  );

  const state = withEnv({ CLAUDE_PLUGIN_DATA: pluginDataDir }, () =>
    JSON.parse(fs.readFileSync(resolveStateFile(workspace), "utf8"))
  );
  assert.equal(state.jobs.length, 48);
  assert.equal(new Set(state.jobs.map((job) => job.id)).size, 48);
});
