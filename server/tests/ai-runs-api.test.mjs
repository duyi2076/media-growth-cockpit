import assert from "node:assert/strict";
import http from "node:http";
import { describe, it } from "node:test";
import { createAiRunsMiddleware } from "../ai-runs-api.mjs";
import { AiDeliveryCommitError } from "../ai-collaboration/ai-delivery-service.mjs";

const RUN_ID = "run-123e4567-e89b-42d3-a456-426614174000";
const PERMISSION_ID = "perm-123e4567-e89b-42d3-a456-426614174000";

function run(status = "queued", { seq = 1, updatedAt = "2026-07-14T00:00:00.000Z" } = {}) {
  return {
    id: RUN_ID,
    provider: "kimi",
    status,
    templateId: "analyze-topic",
    context: { type: "topic", id: "topic-1", title: "测试选题", summary: "测试摘要" },
    permissionMode: "readonly",
    instruction: "",
    finalText: status === "completed" ? "完成" : "",
    pendingPermission: null,
    importedAt: null,
    importedRelativePath: null,
    events: [{
      seq,
      id: `event-${RUN_ID}-${seq}`,
      type: "status",
      status,
      createdAt: updatedAt,
    }],
    error: null,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt,
  };
}

async function startServer(service) {
  const middleware = createAiRunsMiddleware({ service });
  const server = http.createServer((request, response) => middleware(request, response, () => {
    response.statusCode = 404;
    response.end();
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  return {
    base,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function mockService(overrides = {}) {
  return {
    async list() { return { runs: [run()] }; },
    async create() { return run(); },
    async get() { return run(); },
    async cancel() { return run("cancelled"); },
    async respondPermission() { return run("running"); },
    async importResult() { return { ...run("completed"), importedAt: "2026-07-14T00:01:00.000Z" }; },
    async deliverResult() {
      const delivery = {
        id: "delivery-123",
        kind: "content_draft",
        status: "completed",
        sourceRunId: RUN_ID,
        sourceTaskId: "task-1",
        targetType: "content",
        targetId: "content-1",
        targetRelativePath: "30-内容资产/01-文章/草稿.md",
        targetTitle: "草稿",
        createdAt: "2026-07-14T00:01:00.000Z",
      };
      return { run: { ...run("completed"), deliveries: [delivery] }, delivery, created: true };
    },
    subscribe() { return () => {}; },
    async close() {},
    ...overrides,
  };
}

function parseSseRuns(body) {
  return body.split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)));
}

const validBody = {
  provider: "kimi",
  templateId: "analyze-topic",
  context: { type: "topic", id: "topic-1" },
  instruction: "给一个最小动作",
  permissionMode: "readonly",
};

describe("AI 运行 HTTP API", () => {
  it("GET 列表与同源、带 CSRF 标记的 POST 创建可用", async () => {
    let received = null;
    const endpoint = await startServer(mockService({
      async create(input) {
        received = input;
        return run();
      },
    }));
    try {
      const listed = await fetch(`${endpoint.base}/api/ai-runs`);
      assert.equal(listed.status, 200);
      assert.equal((await listed.json()).runs[0].id, RUN_ID);

      const created = await fetch(`${endpoint.base}/api/ai-runs`, {
        method: "POST",
        headers: {
          Origin: endpoint.base,
          "Content-Type": "application/json",
          "X-Cockpit-CSRF": "1",
        },
        body: JSON.stringify(validBody),
      });
      assert.equal(created.status, 202);
      assert.equal((await created.json()).run.id, RUN_ID);
      assert.deepEqual(received, validBody);
    } finally {
      await endpoint.close();
    }
  });

  it("所有写操作都拒绝缺失 Origin、CSRF、未知字段和请求体注入", async () => {
    const endpoint = await startServer(mockService());
    try {
      const withoutOrigin = await fetch(`${endpoint.base}/api/ai-runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Cockpit-CSRF": "1" },
        body: JSON.stringify(validBody),
      });
      assert.equal(withoutOrigin.status, 403);

      const withoutCsrf = await fetch(`${endpoint.base}/api/ai-runs`, {
        method: "POST",
        headers: { Origin: endpoint.base, "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });
      assert.equal(withoutCsrf.status, 403);

      const unknownField = await fetch(`${endpoint.base}/api/ai-runs`, {
        method: "POST",
        headers: {
          Origin: endpoint.base,
          "Content-Type": "application/json",
          "X-Cockpit-CSRF": "1",
        },
        body: JSON.stringify({ ...validBody, executable: "/bin/sh" }),
      });
      assert.equal(unknownField.status, 400);

      const forgedContext = await fetch(`${endpoint.base}/api/ai-runs`, {
        method: "POST",
        headers: {
          Origin: endpoint.base,
          "Content-Type": "application/json",
          "X-Cockpit-CSRF": "1",
        },
        body: JSON.stringify({
          ...validBody,
          context: { ...validBody.context, title: "浏览器伪造标题", summary: "浏览器伪造摘要" },
        }),
      });
      assert.equal(forgedContext.status, 400);

      const cancelWithBody = await fetch(`${endpoint.base}/api/ai-runs/${RUN_ID}/cancel`, {
        method: "POST",
        headers: {
          Origin: endpoint.base,
          "Content-Type": "application/json",
          "X-Cockpit-CSRF": "1",
        },
        body: "{}",
      });
      assert.equal(cancelWithBody.status, 400);
    } finally {
      await endpoint.close();
    }
  });

  it("取消、一次性权限和人工导入使用固定路径与契约", async () => {
    const calls = [];
    const endpoint = await startServer(mockService({
      async cancel(id) { calls.push(["cancel", id]); return run("cancelled"); },
      async respondPermission(id, permissionId, optionId) {
        calls.push(["permission", id, permissionId, optionId]);
        return run("running");
      },
      async importResult(id) { calls.push(["import", id]); return run("completed"); },
    }));
    const writeHeaders = { Origin: endpoint.base, "X-Cockpit-CSRF": "1" };
    try {
      assert.equal((await fetch(`${endpoint.base}/api/ai-runs/${RUN_ID}/cancel`, {
        method: "POST",
        headers: writeHeaders,
      })).status, 200);
      assert.equal((await fetch(`${endpoint.base}/api/ai-runs/${RUN_ID}/permissions/${PERMISSION_ID}`, {
        method: "POST",
        headers: { ...writeHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ optionId: "allow-once" }),
      })).status, 200);
      assert.equal((await fetch(`${endpoint.base}/api/ai-runs/${RUN_ID}/import`, {
        method: "POST",
        headers: writeHeaders,
      })).status, 200);
      assert.deepEqual(calls, [
        ["cancel", RUN_ID],
        ["permission", RUN_ID, PERMISSION_ID, "allow-once"],
        ["import", RUN_ID],
      ]);
    } finally {
      await endpoint.close();
    }
  });

  it("来源任务与成果交付只接受不透明 ID 和业务字段，不接受正文或路径注入", async () => {
    const calls = [];
    const endpoint = await startServer(mockService({
      async create(input) { calls.push(["create", input]); return run(); },
      async deliverResult(id, input) {
        calls.push(["deliver", id, input]);
        return mockService().deliverResult();
      },
    }));
    const headers = {
      Origin: endpoint.base,
      "Content-Type": "application/json",
      "X-Cockpit-CSRF": "1",
    };
    try {
      const created = await fetch(`${endpoint.base}/api/ai-runs`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...validBody, sourceTaskId: "task-1" }),
      });
      assert.equal(created.status, 202);
      assert.equal(calls[0][1].sourceTaskId, "task-1");

      const delivered = await fetch(`${endpoint.base}/api/ai-runs/${RUN_ID}/deliveries`, {
        method: "POST",
        headers,
        body: JSON.stringify({ kind: "content_draft", contentFormat: "文章", title: "草稿" }),
      });
      assert.equal(delivered.status, 201);
      assert.equal((await delivered.json()).delivery.targetId, "content-1");
      assert.deepEqual(calls[1], [
        "deliver",
        RUN_ID,
        { kind: "content_draft", contentFormat: "文章", title: "草稿" },
      ]);

      for (const injected of [
        { kind: "content_draft", contentFormat: "文章", title: "草稿", body: "浏览器伪造正文" },
        { kind: "content_draft", contentFormat: "文章", title: "草稿", targetPath: "../../outside.md" },
        { kind: "content_draft", contentFormat: "短视频", title: "旧界面类型" },
        { kind: "review_draft", reviewKind: "content-review", title: "伪造复盘", findings: ["浏览器伪造正文"] },
      ]) {
        const response = await fetch(`${endpoint.base}/api/ai-runs/${RUN_ID}/deliveries`, {
          method: "POST",
          headers,
          body: JSON.stringify(injected),
        });
        assert.equal(response.status, 400);
      }
    } finally {
      await endpoint.close();
    }
  });

  it("交付清单状态不确定时返回真实的保留与重试语义", async () => {
    const endpoint = await startServer(mockService({
      async deliverResult() {
        throw new AiDeliveryCommitError("业务成果已写入 Obsidian，但运行清单尚未记录；成果已保留，请重试认领");
      },
    }));
    try {
      const response = await fetch(`${endpoint.base}/api/ai-runs/${RUN_ID}/deliveries`, {
        method: "POST",
        headers: {
          Origin: endpoint.base,
          "Content-Type": "application/json",
          "X-Cockpit-CSRF": "1",
        },
        body: JSON.stringify({ kind: "content_draft", contentFormat: "文章", title: "草稿" }),
      });
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), {
        error: "delivery_uncertain",
        message: "业务成果已写入 Obsidian，但运行清单尚未记录；成果已保留，请重试认领",
      });
    } finally {
      await endpoint.close();
    }
  });

  it("SSE 先发送当前快照，再由事件推送终态，不使用短轮询", async () => {
    const endpoint = await startServer(mockService({
      async get() { return run("running"); },
      subscribe(_id, listener) {
        const timer = setTimeout(() => listener({
          ...run("completed", { seq: 2, updatedAt: "2026-07-14T00:00:01.000Z" }),
          finalText: "完成",
        }), 10);
        return () => clearTimeout(timer);
      },
    }));
    try {
      const response = await fetch(`${endpoint.base}/api/ai-runs/${RUN_ID}/events`, {
        headers: { Origin: endpoint.base },
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /text\/event-stream/);
      const body = await response.text();
      assert.equal((body.match(/event: run/g) ?? []).length, 2);
      assert.match(body, /"status":"running"/);
      assert.match(body, /"status":"completed"/);
    } finally {
      await endpoint.close();
    }
  });

  it("SSE 先订阅再读取并复核快照，快速终态不会在 get 与 subscribe 之间丢失", async () => {
    let listener = null;
    let current = run("running");
    let getCalls = 0;
    const order = [];
    const endpoint = await startServer(mockService({
      async get() {
        order.push("get");
        getCalls += 1;
        const snapshot = current;
        if (getCalls === 1) {
          queueMicrotask(() => {
            current = {
              ...run("completed", { seq: 2, updatedAt: "2026-07-14T00:00:01.000Z" }),
              finalText: "快速完成",
            };
            listener?.(current);
          });
        }
        return snapshot;
      },
      subscribe(_id, nextListener) {
        order.push("subscribe");
        listener = nextListener;
        let fallback = null;
        if (current.status === "completed") {
          fallback = setTimeout(() => nextListener(run("failed", {
            seq: 3,
            updatedAt: "2026-07-14T00:00:02.000Z",
          })), 10);
        }
        return () => {
          listener = null;
          if (fallback) clearTimeout(fallback);
        };
      },
    }));
    try {
      const response = await fetch(`${endpoint.base}/api/ai-runs/${RUN_ID}/events`, {
        headers: { Origin: endpoint.base },
      });
      const body = await response.text();
      const snapshots = parseSseRuns(body);
      assert.equal(response.status, 200);
      assert.equal(order[0], "subscribe");
      assert.equal(getCalls, 2);
      assert.deepEqual(snapshots.map((snapshot) => snapshot.status), ["running", "completed"]);
      assert.equal(snapshots[1].finalText, "快速完成");
      assert.equal(snapshots.length, 2);
    } finally {
      await endpoint.close();
    }
  });
});
