#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { terminateProcessTree } from "./lib/process.mjs";
import { BROKER_ENDPOINT_ENV } from "./lib/app-server.mjs";
import {
  LOG_FILE_ENV,
  loadBrokerSession,
  PID_FILE_ENV,
  releaseBrokerSession,
  sendBrokerShutdown,
  teardownBrokerSession
} from "./lib/broker-lifecycle.mjs";
import { resolveJobFile, updateState } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let removedJobs = [];
  updateState(workspaceRoot, (state) => {
    removedJobs = state.jobs.filter((job) => job.sessionId === sessionId);
    state.jobs = state.jobs.filter((job) => job.sessionId !== sessionId);
  });
  if (removedJobs.length === 0) {
    return;
  }

  for (const job of removedJobs) {
    const stillRunning = job.status === "queued" || job.status === "running";
    if (stillRunning) {
      try {
        terminateProcessTree(job.pid ?? Number.NaN);
      } catch {
        // Ignore teardown failures during session shutdown.
      }
    }

    for (const filePath of [resolveJobFile(workspaceRoot, job.id), job.logFile]) {
      if (!filePath || !fs.existsSync(filePath)) {
        continue;
      }
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Ignore teardown file races during session shutdown.
      }
    }
  }
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

async function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  const sessionId = input.session_id || process.env[SESSION_ID_ENV];
  const brokerSession =
    loadBrokerSession(cwd) ??
    (process.env[BROKER_ENDPOINT_ENV]
      ? {
          endpoint: process.env[BROKER_ENDPOINT_ENV],
          pidFile: process.env[PID_FILE_ENV] ?? null,
          logFile: process.env[LOG_FILE_ENV] ?? null
        }
      : null);

  cleanupSessionJobs(cwd, sessionId);

  const released = releaseBrokerSession(cwd, sessionId);
  const teardownSession = released.session ?? brokerSession;
  if (!teardownSession) {
    return;
  }

  const shouldTeardown = released.session ? released.shouldTeardown : true;
  if (!shouldTeardown) {
    return;
  }

  const brokerEndpoint = teardownSession.endpoint ?? null;
  if (brokerEndpoint) {
    await sendBrokerShutdown(brokerEndpoint);
  }

  teardownBrokerSession({
    endpoint: brokerEndpoint,
    pidFile: teardownSession.pidFile ?? null,
    logFile: teardownSession.logFile ?? null,
    sessionDir: teardownSession.sessionDir ?? null,
    pid: teardownSession.pid ?? null,
    killProcess: terminateProcessTree
  });
}

async function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    await handleSessionEnd(input);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
