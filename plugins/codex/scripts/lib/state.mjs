import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const ISOLATION_KEY_ENV = "CODEX_COMPANION_ISOLATION_KEY";
const ISOLATION_MODE_ENV = "CODEX_COMPANION_ISOLATION";
const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
const STATE_LOCK_FILE_NAME = "state.lock";
const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 10_000;

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

function canonicalize(value) {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return value;
  }
}

function slugify(value) {
  const slugSource = path.basename(String(value).split("\0")[0]) || String(value) || "workspace";
  return slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function tryGitWorktreeRoot(cwd) {
  try {
    const output = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return output ? canonicalize(output) : null;
  } catch {
    return null;
  }
}

export function resolveIsolationKey(cwd) {
  const explicit = process.env[ISOLATION_KEY_ENV]?.trim();
  if (explicit) {
    return explicit;
  }

  const worktreeRoot = tryGitWorktreeRoot(cwd);
  const key = worktreeRoot ?? canonicalize(resolveWorkspaceRoot(cwd));
  const isolationMode = process.env[ISOLATION_MODE_ENV]?.trim().toLowerCase();
  const sessionId = process.env[SESSION_ID_ENV]?.trim();

  if (isolationMode === "session" && sessionId) {
    return `${key}\0${sessionId}`;
  }

  return key;
}

export function resolveStateDir(cwd) {
  const isolationKey = resolveIsolationKey(cwd);
  const slug = slugify(isolationKey);
  const hash = createHash("sha256").update(isolationKey).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

function resolveStateLockFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_LOCK_FILE_NAME);
}

function acquireStateLock(lockFile) {
  const startedAt = Date.now();
  let delayMs = 10;

  while (true) {
    try {
      const fd = fs.openSync(lockFile, "wx");
      fs.writeFileSync(
        fd,
        `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
        "utf8"
      );
      fs.closeSync(fd);
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }

      try {
        const stat = fs.statSync(lockFile);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lockFile);
          continue;
        }
      } catch (statError) {
        if (statError?.code !== "ENOENT") {
          throw statError;
        }
        continue;
      }

      if (Date.now() - startedAt > LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for state lock: ${lockFile}`);
      }

      sleepSync(delayMs);
      delayMs = Math.min(delayMs * 2, 100);
    }
  }
}

export function withStateLock(cwd, fn) {
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true });
  const lockFile = resolveStateLockFile(cwd);
  acquireStateLock(lockFile);
  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(lockFile);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

function atomicWriteJson(filePath, payload) {
  const tmpFile = `${filePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  try {
    fs.writeFileSync(tmpFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.renameSync(tmpFile, filePath);
  } finally {
    if (fs.existsSync(tmpFile)) {
      fs.unlinkSync(tmpFile);
    }
  }
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

function loadStateUnlocked(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

export function loadState(cwd) {
  return loadStateUnlocked(cwd);
}

function isActiveJob(job) {
  return job?.status === "queued" || job?.status === "running";
}

function pruneJobs(jobs) {
  const sorted = [...jobs].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
  const active = sorted.filter(isActiveJob);
  const inactive = sorted.filter((job) => !isActiveJob(job));
  return [...active, ...inactive.slice(0, MAX_JOBS)];
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function saveStateUnlocked(cwd, state, previousState = loadStateUnlocked(cwd)) {
  const previousJobs = previousState.jobs;
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    if (isActiveJob(job)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile);
  }

  atomicWriteJson(resolveStateFile(cwd), nextState);
  return nextState;
}

export function saveState(cwd, state) {
  return withStateLock(cwd, () => saveStateUnlocked(cwd, state));
}

export function updateState(cwd, mutate) {
  return withStateLock(cwd, () => {
    const previousState = loadStateUnlocked(cwd);
    const state = {
      ...previousState,
      config: { ...(previousState.config ?? {}) },
      jobs: [...(previousState.jobs ?? [])]
    };
    mutate(state);
    return saveStateUnlocked(cwd, state, previousState);
  });
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  fs.writeFileSync(jobFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
