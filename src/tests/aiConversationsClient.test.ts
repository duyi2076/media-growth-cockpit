import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AiConversationConflictError,
  acceptAiConversationTurn,
  cancelAiConversationTurn,
  closeAiConversation,
  createAiConversation,
  createAiConversationTurn,
  getAiConversations,
  importAiConversation,
  respondAiConversationPermission,
  subscribeToAiConversation,
} from "@/data/aiConversationsClient";

const fixture = {
  id: "conversation-client-1",
  provider: "codex",
  status: "open",
  templateId: "collaborate",
  context: null,
  sourceTask: null,
  permissionMode: "readonly",
  revision: 2,
  activeTurnId: null,
  acceptedTurnId: "turn-client-1",
  acceptedAt: "2026-07-14T10:01:00.000Z",
  importedTurnId: null,
  importedAt: null,
  importedRelativePath: null,
  turns: [{
    id: "turn-client-1",
    seq: 1,
    clientRequestId: "request-client-1",
    userText: "帮我分析",
    status: "completed",
    assistantText: "分析结果",
    outputSha256: "output-client-1",
    stopReason: "end_turn",
    error: null,
    events: [],
    createdAt: "2026-07-14T10:00:00.000Z",
    startedAt: "2026-07-14T10:00:00.000Z",
    completedAt: "2026-07-14T10:01:00.000Z",
  }],
  pendingPermission: null,
  createdAt: "2026-07-14T10:00:00.000Z",
  updatedAt: "2026-07-14T10:01:00.000Z",
};

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => vi.unstubAllGlobals());

describe("AI conversations client", () => {
  it("accepts the collaborate template, a nullable context, and turn-specific import state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ conversations: [{
      ...fixture,
      pendingPermission: {
        id: "permission-client-1",
        turnId: "turn-client-1",
        toolCallId: "tool-client-1",
        title: "确认一次操作",
        kind: null,
        scope: ["内容工作区"],
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        createdAt: fixture.createdAt,
        expiresAt: fixture.updatedAt,
      },
      importedTurnId: "turn-client-1",
      importedAt: fixture.updatedAt,
    }] })));
    await expect(getAiConversations()).resolves.toMatchObject([{
      templateId: "collaborate",
      context: null,
      acceptedAt: fixture.acceptedAt,
      importedTurnId: "turn-client-1",
      pendingPermission: { kind: null, scope: ["内容工作区"] },
    }]);
  });

  it("sends the multi-turn revision and delivery contracts to their exact endpoints", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json({ conversation: fixture }));
    vi.stubGlobal("fetch", fetchMock);

    await createAiConversation({
      provider: "codex",
      templateId: "collaborate",
      permissionMode: "readonly",
      message: "开始自由协作",
      clientRequestId: "request-client-create",
    });
    await createAiConversationTurn(fixture.id, {
      message: "继续追问",
      clientRequestId: "request-client-2",
      expectedRevision: 2,
    });
    await acceptAiConversationTurn(fixture.id, {
      turnId: "turn-client-1",
      outputSha256: "output-client-1",
      expectedRevision: 3,
    });
    await importAiConversation(fixture.id);
    await closeAiConversation(fixture.id);

    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/ai-conversations",
      "/api/ai-conversations/conversation-client-1/turns",
      "/api/ai-conversations/conversation-client-1/accept",
      "/api/ai-conversations/conversation-client-1/import",
      "/api/ai-conversations/conversation-client-1/close",
    ]);
    const firstBody = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(firstBody).not.toHaveProperty("context");
    expect(firstBody).toMatchObject({
      templateId: "collaborate",
      message: "开始自由协作",
      clientRequestId: "request-client-create",
    });
    expect(JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body))).toMatchObject({
      message: "继续追问",
      clientRequestId: "request-client-2",
      expectedRevision: 2,
    });
  });

  it("refreshes the latest snapshot and exposes it for every existing-conversation conflict", async () => {
    const latest = {
      ...fixture,
      status: "closed",
      revision: 9,
      updatedAt: "2026-07-14T10:09:00.000Z",
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") return json({ conversation: latest });
      return json({ message: "会话版本已变化，请刷新后重试" }, 409);
    });
    vi.stubGlobal("fetch", fetchMock);

    const mutations = [
      () => createAiConversationTurn(fixture.id, {
        message: "继续追问",
        clientRequestId: "request-client-2",
        expectedRevision: fixture.revision,
      }),
      () => cancelAiConversationTurn(fixture.id, "turn-client-1"),
      () => respondAiConversationPermission(fixture.id, "turn-client-1", "permission-client-1", "allow"),
      () => acceptAiConversationTurn(fixture.id, {
        turnId: "turn-client-1",
        outputSha256: "output-client-1",
        expectedRevision: fixture.revision,
      }),
      () => importAiConversation(fixture.id),
      () => closeAiConversation(fixture.id),
    ];

    for (const mutate of mutations) {
      let caught: unknown;
      try {
        await mutate();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AiConversationConflictError);
      expect(caught).toMatchObject({
        status: 409,
        message: "会话版本已变化，请刷新后重试",
        snapshot: { id: fixture.id, revision: 9, status: "closed" },
      });
    }

    const calls = fetchMock.mock.calls.map(([path, init]) => ({
      path: String(path),
      method: (init as RequestInit | undefined)?.method ?? "GET",
    }));
    expect(calls.filter((call) => call.method === "GET")).toEqual(Array.from({ length: mutations.length }, () => ({
      path: "/api/ai-conversations/conversation-client-1",
      method: "GET",
    })));
    expect(calls.filter((call) => call.method !== "GET").map((call) => call.path)).toEqual([
      "/api/ai-conversations/conversation-client-1/turns",
      "/api/ai-conversations/conversation-client-1/turns/turn-client-1/cancel",
      "/api/ai-conversations/conversation-client-1/turns/turn-client-1/permissions/permission-client-1",
      "/api/ai-conversations/conversation-client-1/accept",
      "/api/ai-conversations/conversation-client-1/import",
      "/api/ai-conversations/conversation-client-1/close",
    ]);
  });

  it("streams complete conversation snapshots and closes cleanly", () => {
    class EventSourceStub {
      static latest: EventSourceStub | null = null;
      listeners = new Map<string, EventListener>();
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      onerror: (() => void) | null = null;
      close = vi.fn();
      constructor(readonly url: string) { EventSourceStub.latest = this; }
      addEventListener(type: string, listener: EventListener) { this.listeners.set(type, listener); }
    }
    vi.stubGlobal("EventSource", EventSourceStub as unknown as typeof EventSource);
    const onConversation = vi.fn();
    const subscription = subscribeToAiConversation(fixture.id, { onConversation, onError: vi.fn() });
    const event = new MessageEvent("conversation", { data: JSON.stringify({ conversation: fixture }) });
    EventSourceStub.latest!.listeners.get("conversation")!(event);
    expect(EventSourceStub.latest?.url).toBe("/api/ai-conversations/conversation-client-1/events");
    expect(onConversation).toHaveBeenCalledWith(expect.objectContaining({ id: fixture.id, context: null }));
    subscription.close();
    expect(EventSourceStub.latest?.close).toHaveBeenCalled();
  });
});
