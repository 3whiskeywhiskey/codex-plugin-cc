import test from "node:test";
import assert from "node:assert/strict";

import { createBrokerEndpoint, parseBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";
import {
  joinBrokerSession,
  loadBrokerSession,
  releaseBrokerSession,
  saveBrokerSession
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { makeTempDir } from "./helpers.mjs";

test("createBrokerEndpoint uses Unix sockets on non-Windows platforms", () => {
  const endpoint = createBrokerEndpoint("/tmp/cxc-12345", "darwin");
  assert.equal(endpoint, "unix:/tmp/cxc-12345/broker.sock");
  assert.deepEqual(parseBrokerEndpoint(endpoint), {
    kind: "unix",
    path: "/tmp/cxc-12345/broker.sock"
  });
});

test("createBrokerEndpoint uses named pipes on Windows", () => {
  const endpoint = createBrokerEndpoint("C:\\\\Temp\\\\cxc-12345", "win32");
  assert.equal(endpoint, "pipe:\\\\.\\pipe\\cxc-12345-codex-app-server");
  assert.deepEqual(parseBrokerEndpoint(endpoint), {
    kind: "pipe",
    path: "\\\\.\\pipe\\cxc-12345-codex-app-server"
  });
});

test("broker session refs keep shared broker alive until the last session leaves", () => {
  const workspace = makeTempDir();
  saveBrokerSession(workspace, {
    endpoint: "unix:/tmp/cxc-test/broker.sock",
    pidFile: "/tmp/cxc-test/broker.pid",
    logFile: "/tmp/cxc-test/broker.log",
    sessionDir: "/tmp/cxc-test",
    pid: 12345,
    sessions: ["sess-a", "sess-b"]
  });

  const first = releaseBrokerSession(workspace, "sess-a");
  assert.equal(first.shouldTeardown, false);
  assert.deepEqual(loadBrokerSession(workspace).sessions, ["sess-b"]);

  const second = releaseBrokerSession(workspace, "sess-b");
  assert.equal(second.shouldTeardown, true);
  assert.equal(loadBrokerSession(workspace), null);
});

test("joinBrokerSession records the current session id", () => {
  const workspace = makeTempDir();
  saveBrokerSession(workspace, {
    endpoint: "unix:/tmp/cxc-test/broker.sock"
  });

  const session = joinBrokerSession(
    workspace,
    { endpoint: "unix:/tmp/cxc-test/broker.sock" },
    { CODEX_COMPANION_SESSION_ID: "sess-current" }
  );

  assert.deepEqual(session.sessions, ["sess-current"]);
  assert.deepEqual(loadBrokerSession(workspace).sessions, ["sess-current"]);
});
