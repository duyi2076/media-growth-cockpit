#!/usr/bin/env node
import { Readable, Writable } from "node:stream";
import fs from "node:fs/promises";
import * as acp from "@agentclientprotocol/sdk";

const sessions = new Map();

async function persistSessions() {
  if (!process.env.MOCK_SESSION_STATE_FILE) return;
  await fs.writeFile(process.env.MOCK_SESSION_STATE_FILE, JSON.stringify([...sessions]), "utf8");
}

async function restoreSessions() {
  if (!process.env.MOCK_SESSION_STATE_FILE) return;
  try {
    const entries = JSON.parse(await fs.readFile(process.env.MOCK_SESSION_STATE_FILE, "utf8"));
    for (const [id, value] of entries) sessions.set(id, { ...value, controller: null });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

await restoreSessions();

const implementation = {
  async initialize() {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        ...(process.env.MOCK_RESUME === "1" ? { sessionCapabilities: { resume: {}, close: {} } } : {}),
      },
    };
  },
  async newSession() {
    const sessionId = `mock-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    sessions.set(sessionId, { controller: null, mode: "default", turns: 0, memory: null });
    await persistSessions();
    return {
      sessionId,
      ...(process.env.MOCK_SESSION_MODES === "1" ? {
        modes: {
          currentModeId: "default",
          availableModes: [
            { id: "default", name: "Manual" },
            { id: "plan", name: "Plan" },
          ],
        },
      } : {}),
    };
  },
  async setMode(params) {
    const session = sessions.get(params.sessionId);
    if (!session) throw new Error("missing session");
    session.mode = params.modeId;
    return {};
  },
  async prompt(params, client, signal) {
    const session = sessions.get(params.sessionId);
    if (!session) throw new Error("missing session");
    session.controller = new AbortController();
    const cancelFromRequest = () => session.controller.abort();
    if (signal?.aborted) cancelFromRequest();
    else signal?.addEventListener("abort", cancelFromRequest, { once: true });
    const prompt = params.prompt.find((block) => block.type === "text")?.text ?? "";
    if (prompt.includes("SLOW")) {
      await client.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "等待取消" },
        },
      });
      await new Promise((resolve) => session.controller.signal.addEventListener("abort", resolve, { once: true }));
      signal?.removeEventListener("abort", cancelFromRequest);
      return { stopReason: "cancelled" };
    }
    if (prompt.includes("IGNORE_CANCEL")) {
      await client.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "仍在运行" },
        },
      });
      await new Promise(() => {});
    }
    session.turns = (session.turns ?? 0) + 1;
    const memoryMatch = prompt.match(/MEMORY:([^\s]+)/);
    if (memoryMatch) session.memory = memoryMatch[1];
    await persistSessions();
    if (prompt.includes("CRASH_AFTER")) process.exit(17);
    if (prompt.includes("SPLIT_SECRET")) {
      for (const text of ["结果 sk-ABCD", "EFGHIJK 已隐藏"]) {
        await client.notify(acp.methods.client.session.update, {
          sessionId: params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
        });
      }
      signal?.removeEventListener("abort", cancelFromRequest);
      return { stopReason: "end_turn" };
    }
    const prefix = prompt.includes("RECALL") ? `记忆：${session.memory ?? "无"}` : `已收到：${prompt}`;
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `${prefix}；轮次：${session.turns}` },
      },
    });
    if (prompt.includes("NO_PERMISSION")) {
      signal?.removeEventListener("abort", cancelFromRequest);
      return { stopReason: "end_turn" };
    }
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "写入测试文件",
        kind: "edit",
        status: "pending",
        locations: [{ path: "/tmp/example.md" }],
      },
    });
    const permission = await client.request(acp.methods.client.session.requestPermission, {
      sessionId: params.sessionId,
      toolCall: {
        toolCallId: "tool-1",
        title: "写入测试文件",
        kind: "edit",
        status: "pending",
        locations: [{ path: "/tmp/example.md" }],
      },
      options: [
        { optionId: "allow-once", name: "仅允许这一次", kind: "allow_once" },
        { optionId: "allow-always", name: "永久允许", kind: "allow_always" },
        { optionId: "reject-once", name: "拒绝这一次", kind: "reject_once" },
      ],
    });
    const selected = permission.outcome.outcome === "selected" ? permission.outcome.optionId : "cancelled";
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `；权限结果：${selected}` },
      },
    });
    if (process.env.MOCK_SESSION_MODES === "1") {
      await client.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `；模式：${session.mode}` },
        },
      });
    }
    signal?.removeEventListener("abort", cancelFromRequest);
    return { stopReason: "end_turn" };
  },
  async cancel(params) {
    sessions.get(params.sessionId)?.controller?.abort();
  },
  async resume(params) {
    const session = sessions.get(params.sessionId);
    if (!session) throw new Error("missing session");
    return {};
  },
  async close(params) {
    if (!sessions.has(params.sessionId)) throw new Error("missing session");
    if (process.env.MOCK_HANG_CLOSE === "1") await new Promise(() => {});
    if (process.env.MOCK_CLOSE_MARKER) await fs.writeFile(process.env.MOCK_CLOSE_MARKER, params.sessionId, "utf8");
    return {};
  },
};

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
acp
  .agent({ name: "cockpit-mock-agent" })
  .onRequest(acp.methods.agent.initialize, (ctx) => implementation.initialize(ctx.params))
  .onRequest(acp.methods.agent.session.new, (ctx) => implementation.newSession(ctx.params))
  .onRequest(acp.methods.agent.session.setMode, (ctx) => implementation.setMode(ctx.params))
  .onRequest(acp.methods.agent.session.prompt, (ctx) => implementation.prompt(ctx.params, ctx.client, ctx.signal))
  .onRequest(acp.methods.agent.session.resume, (ctx) => implementation.resume(ctx.params))
  .onRequest(acp.methods.agent.session.close, (ctx) => implementation.close(ctx.params))
  .onNotification(acp.methods.agent.session.cancel, (ctx) => implementation.cancel(ctx.params))
  .connect(stream);
