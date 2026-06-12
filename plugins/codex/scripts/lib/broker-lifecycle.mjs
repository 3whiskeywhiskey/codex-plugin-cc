import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { resolveStateDir, withStateLock } from "./state.mjs";

export const PID_FILE_ENV = "CODEX_COMPANION_APP_SERVER_PID_FILE";
export const LOG_FILE_ENV = "CODEX_COMPANION_APP_SERVER_LOG_FILE";
const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const BROKER_STATE_FILE = "broker.json";

export function createBrokerSessionDir(prefix = "cxc-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function connectToEndpoint(endpoint) {
  const target = parseBrokerEndpoint(endpoint);
  return net.createConnection({ path: target.path });
}

export async function waitForBrokerEndpoint(endpoint, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await new Promise((resolve) => {
      const socket = connectToEndpoint(endpoint);
      socket.on("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (ready) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

export async function sendBrokerShutdown(endpoint) {
  await new Promise((resolve) => {
    const socket = connectToEndpoint(endpoint);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, method: "broker/shutdown", params: {} })}\n`);
    });
    socket.on("data", () => {
      socket.end();
      resolve();
    });
    socket.on("error", resolve);
    socket.on("close", resolve);
  });
}

export function spawnBrokerProcess({ scriptPath, cwd, endpoint, pidFile, logFile, env = process.env }) {
  const logFd = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, [scriptPath, "serve", "--endpoint", endpoint, "--cwd", cwd, "--pid-file", pidFile], {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd]
  });
  child.unref();
  fs.closeSync(logFd);
  return child;
}

function resolveBrokerStateFile(cwd) {
  return path.join(resolveStateDir(cwd), BROKER_STATE_FILE);
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

function readBrokerSessionFile(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}

function currentSessionId(env = process.env) {
  const sessionId = env?.[SESSION_ID_ENV]?.trim();
  return sessionId || null;
}

function normalizeSessionIds(session) {
  return Array.isArray(session?.sessions)
    ? [...new Set(session.sessions.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))]
    : [];
}

function addSessionRef(session, sessionId) {
  if (!sessionId) {
    return session;
  }
  return {
    ...session,
    sessions: [...new Set([...normalizeSessionIds(session), sessionId])]
  };
}

export function loadBrokerSession(cwd) {
  return readBrokerSessionFile(cwd);
}

export function saveBrokerSession(cwd, session) {
  const stateDir = resolveStateDir(cwd);
  withStateLock(cwd, () => {
    fs.mkdirSync(stateDir, { recursive: true });
    atomicWriteJson(resolveBrokerStateFile(cwd), session);
  });
}

export function clearBrokerSession(cwd) {
  withStateLock(cwd, () => {
    const stateFile = resolveBrokerStateFile(cwd);
    if (fs.existsSync(stateFile)) {
      fs.unlinkSync(stateFile);
    }
  });
}

function saveBrokerSessionUnlocked(cwd, session) {
  atomicWriteJson(resolveBrokerStateFile(cwd), session);
}

function clearBrokerSessionUnlocked(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (fs.existsSync(stateFile)) {
    fs.unlinkSync(stateFile);
  }
}

export function joinBrokerSession(cwd, session, env = process.env) {
  const sessionId = currentSessionId(env);
  if (!sessionId) {
    return session;
  }

  return withStateLock(cwd, () => {
    const latest = readBrokerSessionFile(cwd) ?? session;
    const next = addSessionRef(latest, sessionId);
    saveBrokerSessionUnlocked(cwd, next);
    return next;
  });
}

export function releaseBrokerSession(cwd, sessionId) {
  return withStateLock(cwd, () => {
    const session = readBrokerSessionFile(cwd);
    if (!session) {
      return { session: null, shouldTeardown: false };
    }

    if (!sessionId) {
      clearBrokerSessionUnlocked(cwd);
      return { session, shouldTeardown: true };
    }

    const sessions = normalizeSessionIds(session);
    if (sessions.length === 0) {
      clearBrokerSessionUnlocked(cwd);
      return { session, shouldTeardown: true };
    }

    const remainingSessions = sessions.filter((value) => value !== sessionId);
    if (remainingSessions.length > 0) {
      const next = { ...session, sessions: remainingSessions };
      saveBrokerSessionUnlocked(cwd, next);
      return { session: next, shouldTeardown: false };
    }

    clearBrokerSessionUnlocked(cwd);
    return { session, shouldTeardown: true };
  });
}

async function isBrokerEndpointReady(endpoint) {
  if (!endpoint) {
    return false;
  }
  try {
    return await waitForBrokerEndpoint(endpoint, 150);
  } catch {
    return false;
  }
}

export async function ensureBrokerSession(cwd, options = {}) {
  const existing = loadBrokerSession(cwd);
  if (existing && (await isBrokerEndpointReady(existing.endpoint))) {
    return joinBrokerSession(cwd, existing, options.env);
  }

  if (existing) {
    teardownBrokerSession({
      endpoint: existing.endpoint ?? null,
      pidFile: existing.pidFile ?? null,
      logFile: existing.logFile ?? null,
      sessionDir: existing.sessionDir ?? null,
      pid: existing.pid ?? null,
      killProcess: options.killProcess ?? null
    });
    clearBrokerSession(cwd);
  }

  const sessionDir = createBrokerSessionDir();
  const endpointFactory = options.createBrokerEndpoint ?? createBrokerEndpoint;
  const endpoint = endpointFactory(sessionDir, options.platform);
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  const scriptPath =
    options.scriptPath ??
    fileURLToPath(new URL("../app-server-broker.mjs", import.meta.url));

  const child = spawnBrokerProcess({
    scriptPath,
    cwd,
    endpoint,
    pidFile,
    logFile,
    env: options.env ?? process.env
  });

  const ready = await waitForBrokerEndpoint(endpoint, options.timeoutMs ?? 2000);
  if (!ready) {
    teardownBrokerSession({
      endpoint,
      pidFile,
      logFile,
      sessionDir,
      pid: child.pid ?? null,
      killProcess: options.killProcess ?? null
    });
    return null;
  }

  const session = {
    endpoint,
    pidFile,
    logFile,
    sessionDir,
    pid: child.pid ?? null,
    ...addSessionRef({}, currentSessionId(options.env ?? process.env))
  };
  saveBrokerSession(cwd, session);
  return session;
}

export function teardownBrokerSession({ endpoint = null, pidFile, logFile, sessionDir = null, pid = null, killProcess = null }) {
  if (Number.isFinite(pid) && killProcess) {
    try {
      killProcess(pid);
    } catch {
      // Ignore missing or already-exited broker processes.
    }
  }

  if (pidFile && fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
  }

  if (logFile && fs.existsSync(logFile)) {
    fs.unlinkSync(logFile);
  }

  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint);
      if (target.kind === "unix" && fs.existsSync(target.path)) {
        fs.unlinkSync(target.path);
      }
    } catch {
      // Ignore malformed or already-removed broker endpoints during teardown.
    }
  }

  const resolvedSessionDir = sessionDir ?? (pidFile ? path.dirname(pidFile) : logFile ? path.dirname(logFile) : null);
  if (resolvedSessionDir && fs.existsSync(resolvedSessionDir)) {
    try {
      fs.rmdirSync(resolvedSessionDir);
    } catch {
      // Ignore non-empty or missing directories.
    }
  }
}
