import assert from "node:assert/strict";
import http from "node:http";
import { describe, test } from "node:test";
import { createAiConversationsMiddleware } from "../ai-conversations-api.mjs";

const CONVERSATION_ID = "conv-123e4567-e89b-42d3-a456-426614174000";
const TURN_ID = "turn-123e4567-e89b-42d3-a456-426614174000";
const PERMISSION_ID = "perm-123";

function conversation({ revision = 3, eventCount = 1, status = "open" } = {}) {
  return {
    id: CONVERSATION_ID,
    provider: "codex",
    status,
    templateId: "collaborate",
    context: null,
    sourceTask: null,
    permissionMode: "readonly",
    runtime: null,
    revision,
    activeTurnId: null,
    acceptedTurnId: null,
    acceptedAt: null,
    importedAt: null,
    importedRelativePath: null,
    importedTurnId: null,
    turns: [{
      id: TURN_ID,
      seq: 1,
      clientRequestId: "create-1",
      userText: "你好",
      status: "completed",
      assistantText: "回答",
      outputSha256: "a".repeat(64),
      stopReason: "end_turn",
      error: null,
      events: Array.from({ length: eventCount }, (_, index) => ({
        id: `event-${TURN_ID}-${index + 1}`,
        seq: index + 1,
        type: "message",
        text: `chunk-${index + 1}`,
        createdAt: "2026-07-14T00:00:00.000Z",
      })),
      createdAt: "2026-07-14T00:00:00.000Z",
      startedAt: "2026-07-14T00:00:00.000Z",
      completedAt: "2026-07-14T00:00:01.000Z",
    }],
    pendingPermission: null,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:01.000Z",
  };
}

function mockService(overrides = {}) {
  return {
    async list() { return { conversations: [conversation()] }; },
    async create() { return conversation(); },
    async get() { return conversation(); },
    async addTurn() { return { conversation: conversation(), created: true }; },
    async cancelTurn() { return conversation(); },
    async respondPermission() { return conversation(); },
    async accept() { return conversation(); },
    async importResult() { return { ...conversation(), importedTurnId: TURN_ID }; },
    async closeConversation() { return conversation({ status: "closed" }); },
    subscribe() { return () => {}; },
    async close() {},
    ...overrides,
  };
}

async function startServer(service) {
  const middleware = createAiConversationsMiddleware({ service });
  const server = http.createServer((request, response) => middleware(request, response, () => { response.statusCode = 404; response.end(); }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function writeHeaders(base, json = false) {
  return { Origin: base, "X-Cockpit-CSRF": "1", ...(json ? { "Content-Type": "application/json" } : {}) };
}

describe("AI Conversations HTTP API", () => {
  test("固定 /api/ai-conversations 支持无 context 的自由会话", async () => {
    let received;
    const endpoint = await startServer(mockService({ async create(input) { received = input; return conversation(); } }));
    try {
      const response = await fetch(`${endpoint.base}/api/ai-conversations`, {
        method: "POST",
        headers: writeHeaders(endpoint.base, true),
        body: JSON.stringify({ provider: "codex", message: "自由讨论", clientRequestId: "create-api-1" }),
      });
      assert.equal(response.status, 202);
      assert.equal((await response.json()).conversation.id, CONVERSATION_ID);
      assert.deepEqual(received, {
        provider: "codex",
        message: "自由讨论",
        clientRequestId: "create-api-1",
        templateId: "collaborate",
        permissionMode: "readonly",
      });
    } finally { await endpoint.close(); }
  });

  test("写接口拒绝跨站、缺 CSRF、未知执行字段和 import body", async () => {
    const endpoint = await startServer(mockService());
    try {
      const missing = await fetch(`${endpoint.base}/api/ai-conversations`, {
        method: "POST", headers: { Origin: endpoint.base, "Content-Type": "application/json" }, body: JSON.stringify({ provider: "codex", message: "x" }),
      });
      assert.equal(missing.status, 403);
      const injected = await fetch(`${endpoint.base}/api/ai-conversations`, {
        method: "POST", headers: writeHeaders(endpoint.base, true), body: JSON.stringify({
          provider: "codex", message: "x", clientRequestId: "create-injected", executable: "/bin/sh",
        }),
      });
      assert.equal(injected.status, 400);
      const missingId = await fetch(`${endpoint.base}/api/ai-conversations`, {
        method: "POST", headers: writeHeaders(endpoint.base, true), body: JSON.stringify({ provider: "codex", message: "x" }),
      });
      assert.equal(missingId.status, 400);
      const invalidId = await fetch(`${endpoint.base}/api/ai-conversations`, {
        method: "POST", headers: writeHeaders(endpoint.base, true), body: JSON.stringify({
          provider: "codex", message: "x", clientRequestId: "../unsafe",
        }),
      });
      assert.equal(invalidId.status, 400);
      const bodyOnImport = await fetch(`${endpoint.base}/api/ai-conversations/${CONVERSATION_ID}/import`, {
        method: "POST", headers: writeHeaders(endpoint.base, true), body: "{}",
      });
      assert.equal(bodyOnImport.status, 400);
    } finally { await endpoint.close(); }
  });

  test("turn/cancel/permission/accept/import/close 路由参数严格绑定", async () => {
    const calls = [];
    const endpoint = await startServer(mockService({
      async addTurn(id, input) { calls.push(["turn", id, input]); return { conversation: conversation(), created: true }; },
      async cancelTurn(id, turnId) { calls.push(["cancel", id, turnId]); return conversation(); },
      async respondPermission(id, turnId, permissionId, optionId) { calls.push(["permission", id, turnId, permissionId, optionId]); return conversation(); },
      async accept(id, input) { calls.push(["accept", id, input]); return conversation(); },
      async importResult(id) { calls.push(["import", id]); return conversation(); },
      async closeConversation(id) { calls.push(["close", id]); return conversation({ status: "closed" }); },
    }));
    try {
      await fetch(`${endpoint.base}/api/ai-conversations/${CONVERSATION_ID}/turns`, {
        method: "POST", headers: writeHeaders(endpoint.base, true), body: JSON.stringify({ message: "继续", clientRequestId: "request-2", expectedRevision: 3 }),
      });
      await fetch(`${endpoint.base}/api/ai-conversations/${CONVERSATION_ID}/turns/${TURN_ID}/cancel`, { method: "POST", headers: writeHeaders(endpoint.base) });
      await fetch(`${endpoint.base}/api/ai-conversations/${CONVERSATION_ID}/turns/${TURN_ID}/permissions/${PERMISSION_ID}`, {
        method: "POST", headers: writeHeaders(endpoint.base, true), body: JSON.stringify({ optionId: "reject" }),
      });
      await fetch(`${endpoint.base}/api/ai-conversations/${CONVERSATION_ID}/accept`, {
        method: "POST", headers: writeHeaders(endpoint.base, true), body: JSON.stringify({ turnId: TURN_ID, outputSha256: "a".repeat(64), expectedRevision: 3 }),
      });
      await fetch(`${endpoint.base}/api/ai-conversations/${CONVERSATION_ID}/import`, { method: "POST", headers: writeHeaders(endpoint.base) });
      await fetch(`${endpoint.base}/api/ai-conversations/${CONVERSATION_ID}/close`, { method: "POST", headers: writeHeaders(endpoint.base) });
      assert.deepEqual(calls.map((call) => call[0]), ["turn", "cancel", "permission", "accept", "import", "close"]);
      assert.equal(calls[2][3], PERMISSION_ID);
    } finally { await endpoint.close(); }
  });

  test("SSE 在一轮 completed 后保持连接，并推送下一快照", async () => {
    let listener;
    const endpoint = await startServer(mockService({
      subscribe(_id, callback) { listener = callback; return () => { listener = null; }; },
    }));
    const controller = new AbortController();
    try {
      const response = await fetch(`${endpoint.base}/api/ai-conversations/${CONVERSATION_ID}/events`, { signal: controller.signal });
      assert.equal(response.status, 200);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const first = decoder.decode((await reader.read()).value);
      assert.match(first, /event: conversation/);
      const secondRead = reader.read();
      const premature = await Promise.race([secondRead.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 80))]);
      assert.equal(premature, false, "open conversation 不应在 completed turn 后关闭 SSE");
      listener(conversation({ revision: 4, eventCount: 2 }));
      const second = decoder.decode((await secondRead).value);
      assert.match(second, /chunk-2/);
      controller.abort();
    } finally { await endpoint.close(); }
  });
});
