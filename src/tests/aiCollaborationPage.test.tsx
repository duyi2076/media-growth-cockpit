import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { App } from "@/app/App";
import { WorkbenchIndexProvider } from "@/data/adapter";
import { workbenchIndexFixture } from "./fixtures/workbenchIndex";

const NOW = "2026-07-14T10:00:00.000Z";

const agentsResponse = {
  agents: [
    {
      id: "kimi",
      displayName: "Kimi Code",
      installed: true,
      version: "1.0.0",
      latestStable: "1.0.0",
      testedVersion: "1.0.0",
      versionStatus: "current",
      acpMode: "native",
      status: "ready",
      authStatus: "ready",
      officialSource: "https://moonshotai.github.io/kimi-code/en/guides/getting-started.html",
      actions: { canInstall: true, canUpdate: true, canLogin: true },
    },
    {
      id: "codex",
      displayName: "Codex",
      installed: true,
      version: "1.0.0",
      latestStable: "1.0.0",
      testedVersion: "1.0.0",
      versionStatus: "current",
      acpMode: "adapter",
      status: "ready",
      authStatus: "ready",
      officialSource: "https://help.openai.com/en/articles/11096431",
      actions: { canInstall: true, canUpdate: true, canLogin: true },
      adapter: {
        packageName: "@agentclientprotocol/codex-acp",
        installed: true,
        version: "1.1.2",
        automaticInstall: false,
      },
    },
  ],
  policy: {
    automaticInstall: false,
    automaticUpgrade: false,
    credentialAccess: false,
    userConfirmedActions: true,
    supportedPlatform: "macos",
  },
};

function turn(overrides: Record<string, unknown> = {}) {
  return {
    id: "turn-1",
    seq: 1,
    clientRequestId: "request-1",
    userText: "帮我判断这个方向",
    status: "completed",
    assistantText: "建议先验证真实用户问题，再决定是否扩大投入。",
    outputSha256: "output-one",
    stopReason: "end_turn",
    error: null,
    events: [],
    createdAt: NOW,
    startedAt: NOW,
    completedAt: NOW,
    ...overrides,
  };
}

function conversation(overrides: Record<string, unknown> = {}) {
  return {
    id: "conversation-1",
    provider: "kimi",
    status: "open",
    templateId: "collaborate",
    context: null,
    sourceTask: null,
    permissionMode: "readonly",
    revision: 1,
    activeTurnId: null,
    acceptedTurnId: null,
    importedTurnId: null,
    importedAt: null,
    importedRelativePath: null,
    turns: [turn()],
    pendingPermission: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

class MockEventSource {
  static instances: MockEventSource[] = [];
  readonly url: string;
  readonly listeners = new Map<string, EventListener[]>();
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  close = vi.fn(() => { this.closed = true; });

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener) {
    const current = this.listeners.get(type) ?? [];
    current.push(listener);
    this.listeners.set(type, current);
  }

  emitConversation(value: unknown) {
    if (this.closed) return;
    const event = new MessageEvent("conversation", { data: JSON.stringify({ conversation: value }) });
    for (const listener of this.listeners.get("conversation") ?? []) listener(event);
  }
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

interface FetchOptions {
  agents?: unknown;
  initialConversation?: ReturnType<typeof conversation> | null;
  dailyTasks?: unknown[];
  failCreateOnce?: boolean;
  failTurnOnce?: boolean;
  conflictTurnOnce?: boolean;
  conversationGate?: Promise<void>;
  dailyTasksGate?: Promise<void>;
}

function setupFetch(options: FetchOptions = {}) {
  let current: any = options.initialConversation ?? null;
  let failCreate = Boolean(options.failCreateOnce);
  let failTurn = Boolean(options.failTurnOnce);
  let conflictTurn = Boolean(options.conflictTurnOnce);
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    if (path === "/api/ai-agents" || path === "/api/ai-agents?refresh=1") return json(options.agents ?? agentsResponse);
    if (path === "/api/ai-environment/actions" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { provider: string; action: string };
      return json({ job: {
        id: "ai-env-11111111-1111-4111-8111-111111111111",
        ...body,
        status: "completed",
        message: "安装完成",
        createdAt: NOW,
        updatedAt: NOW,
      } }, 202);
    }
    if (path === "/api/ai-conversations" && method === "GET") return json({ conversations: current ? [current] : [] });
    if (path === "/api/ai-conversations" && method === "POST") {
      if (failCreate) {
        failCreate = false;
        return json({ message: "暂时无法开始会话" }, 503);
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const contextRef = body.context as { type: string; id: string } | undefined;
      const firstTurn = turn({
        id: "turn-created",
        clientRequestId: body.clientRequestId,
        userText: body.message,
        status: "running",
        assistantText: "",
        outputSha256: null,
        stopReason: null,
        completedAt: null,
      });
      current = conversation({
        context: contextRef ? {
          ...contextRef,
          title: workbenchIndexFixture.contents[0].title,
          summary: workbenchIndexFixture.contents[0].summary,
        } : null,
        sourceTask: body.sourceTaskId ? {
          id: body.sourceTaskId,
          date: "2026-07-14",
          title: "完成一篇内容初稿",
          linkType: "topic",
          linkId: workbenchIndexFixture.contents[0].id,
        } : null,
        activeTurnId: firstTurn.id,
        turns: [firstTurn],
        revision: 1,
      });
      return json({ conversation: current }, 201);
    }
    if (path === "/api/review-assets") return json({ items: [], generatedAt: NOW });
    if (path === "/api/daily-reviews") return json({ items: [], generatedAt: NOW });
    if (path === "/api/daily-tasks" && method === "GET") {
      if (options.dailyTasksGate) await options.dailyTasksGate;
      return json({ date: "2026-07-14", tasks: options.dailyTasks ?? [], hash: "d".repeat(64), updatedAt: NOW });
    }
    if (path === "/api/daily-tasks" && method === "PUT") {
      const body = JSON.parse(String(init?.body)) as { tasks: unknown[] };
      return json({ date: "2026-07-14", tasks: body.tasks, hash: "e".repeat(64), updatedAt: NOW });
    }
    if (path === "/api/open-obsidian" && method === "POST") return json({ opened: true });
    if (path.endsWith("/turns") && method === "POST") {
      if (failTurn) {
        failTurn = false;
        return json({ message: "消息暂时没有送达" }, 503);
      }
      if (conflictTurn) {
        conflictTurn = false;
        current = {
          ...current!,
          status: "closed",
          revision: current!.revision + 1,
          updatedAt: "2026-07-14T10:02:00.000Z",
        };
        return json({ message: "会话版本已变化，请刷新后重试" }, 409);
      }
      const body = JSON.parse(String(init?.body)) as { message: string; clientRequestId: string };
      const nextTurn = turn({
        id: `turn-${(current?.turns.length ?? 0) + 1}`,
        seq: (current?.turns.length ?? 0) + 1,
        clientRequestId: body.clientRequestId,
        userText: body.message,
        status: "running",
        assistantText: "",
        outputSha256: null,
        stopReason: null,
        completedAt: null,
      });
      current = { ...current!, revision: current!.revision + 1, activeTurnId: nextTurn.id, turns: [...current!.turns, nextTurn] };
      return json({ conversation: current });
    }
    if (path.endsWith("/cancel") && method === "POST") {
      current = {
        ...current!,
        revision: current!.revision + 1,
        activeTurnId: null,
        turns: current!.turns.map((item: any) => item.id === current!.activeTurnId ? { ...item, status: "cancelled", completedAt: NOW } : item),
      };
      return json({ conversation: current });
    }
    if (path.includes("/permissions/") && method === "POST") {
      current = {
        ...current!,
        revision: current!.revision + 1,
        pendingPermission: null,
        turns: current!.turns.map((item: any) => item.id === current!.activeTurnId ? { ...item, status: "running" } : item),
      };
      return json({ conversation: current });
    }
    if (path.endsWith("/accept") && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { turnId: string };
      current = { ...current!, revision: current!.revision + 1, acceptedTurnId: body.turnId };
      return json({ conversation: current });
    }
    if (path.endsWith("/import") && method === "POST") {
      current = {
        ...current!,
        revision: current!.revision + 1,
        importedTurnId: current!.acceptedTurnId,
        importedAt: NOW,
        importedRelativePath: "30-内容资产/AI成果.md",
      };
      return json({ conversation: current });
    }
    if (path.endsWith("/close") && method === "POST") {
      current = { ...current!, status: "closed", revision: current!.revision + 1 };
      return json({ conversation: current });
    }
    if (path.startsWith("/api/ai-conversations/") && method === "GET") {
      if (options.conversationGate) await options.conversationGate;
      return current ? json({ conversation: current }) : json({ message: "not found" }, 404);
    }
    throw new Error(`Unexpected fetch ${method} ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
  return { fetchMock, current: () => current };
}

function renderPage(path = "/ai") {
  return render(
    <WorkbenchIndexProvider initialData={workbenchIndexFixture}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </WorkbenchIndexProvider>,
  );
}

function conversationEventSource() {
  return [...MockEventSource.instances]
    .reverse()
    .find((source) => !source.closed && source.url.includes("/api/ai-conversations/"));
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  MockEventSource.instances = [];
});

describe("AI conversation workbench", () => {
  it("detects first and offers a confirmed Antigravity install without exposing legacy Gemini", async () => {
    const missingAntigravity = {
      id: "antigravity",
      displayName: "Antigravity",
      installed: false,
      version: null,
      latestStable: "1.1.2",
      testedVersion: "1.0.16",
      versionStatus: "unknown",
      acpMode: "conversation_cli",
      status: "missing",
      authStatus: "unknown",
      officialSource: "https://antigravity.google/docs/cli-reference",
      actions: { canInstall: true, canUpdate: true, canLogin: true },
    };
    const customAgents = { ...agentsResponse, agents: [...agentsResponse.agents, missingAntigravity] };
    const { fetchMock } = setupFetch({ agents: customAgents });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /管理本机 AI/ }, { timeout: 5_000 }));
    expect(await screen.findByText("Antigravity")).toBeInTheDocument();
    expect(screen.queryByText("Gemini CLI")).not.toBeInTheDocument();
    const row = screen.getByText("Antigravity").closest("article");
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "安装" }));
    await waitFor(() => {
      const request = fetchMock.mock.calls.find(([path, init]) => String(path) === "/api/ai-environment/actions" && (init as RequestInit)?.method === "POST");
      expect(JSON.parse(String((request?.[1] as RequestInit).body))).toEqual({ provider: "antigravity", action: "install" });
    });
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("官方固定流程"));
  });
  it("starts as a long-lived chat and creates a context-free conversation from the first message", async () => {
    const { fetchMock } = setupFetch();
    const view = renderPage();

    expect(await screen.findByRole("heading", { name: "今天想和 AI 一起处理什么？" })).toBeInTheDocument();
    expect(screen.queryByText("开始一次协作")).not.toBeInTheDocument();
    expect(screen.queryByText("成果版本")).not.toBeInTheDocument();
    expect(view.container.querySelector(".ai-message-scroll")).toBeInTheDocument();
    expect(view.container.querySelector(".ai-conversation-composer")).toBeInTheDocument();

    const input = screen.getByRole("textbox", { name: "继续提问" });
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.change(input, { target: { value: "帮我一起梳理今天的创作重点" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await screen.findByText("帮我一起梳理今天的创作重点");
    const request = fetchMock.mock.calls.find(([path, init]) => String(path) === "/api/ai-conversations" && (init as RequestInit | undefined)?.method === "POST");
    const body = JSON.parse(String((request?.[1] as RequestInit).body));
    expect(body).toMatchObject({ provider: "kimi", templateId: "collaborate", message: "帮我一起梳理今天的创作重点" });
    expect(body).not.toHaveProperty("context");
  });

  it("adds an optional context chip without turning the first screen into a launch form", async () => {
    const { fetchMock } = setupFetch();
    renderPage();
    await screen.findByRole("combobox", { name: "选择 AI" });

    fireEvent.click(screen.getByRole("button", { name: "资料" }));
    const drawer = await screen.findByRole("region", { name: "添加资料" });
    fireEvent.change(within(drawer).getByRole("combobox", { name: "任务资料" }), { target: { value: workbenchIndexFixture.contents[0].id } });
    fireEvent.click(within(drawer).getByRole("button", { name: "添加资料" }));
    expect(await screen.findByText(workbenchIndexFixture.contents[0].title)).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "继续提问" }), { target: { value: "从这个选题开始" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => {
      const request = fetchMock.mock.calls.find(([path, init]) => String(path) === "/api/ai-conversations" && (init as RequestInit | undefined)?.method === "POST");
      expect(JSON.parse(String((request?.[1] as RequestInit).body))).toMatchObject({
        context: { type: "topic", id: workbenchIndexFixture.contents[0].id },
      });
    });
  });

  it("keeps a draft editable while the current turn is running and resubscribes for later turns", async () => {
    const runningTurn = turn({ status: "running", assistantText: "", outputSha256: null, completedAt: null });
    const initial = conversation({ activeTurnId: runningTurn.id, turns: [runningTurn] });
    const { current } = setupFetch({ initialConversation: initial });
    renderPage("/ai?conversationId=conversation-1");

    const input = await screen.findByRole("textbox", { name: "继续提问" });
    fireEvent.change(input, { target: { value: "下一轮请给出三个标题" } });
    expect(input).toHaveValue("下一轮请给出三个标题");
    expect(screen.getByRole("button", { name: "停止回复" })).toBeInTheDocument();
    expect(input).toBeEnabled();

    await waitFor(() => expect(conversationEventSource()).toBeTruthy());
    const streaming = conversation({
      activeTurnId: runningTurn.id,
      turns: [turn({
        status: "running",
        assistantText: "",
        outputSha256: null,
        completedAt: null,
        events: [{
          seq: 1,
          id: "event-turn-1-1",
          type: "message",
          createdAt: NOW,
          text: "正在流式输出第一段",
        }],
      })],
      revision: 1,
    });
    conversationEventSource()!.emitConversation(streaming);
    expect(await screen.findByText("正在流式输出第一段")).toBeInTheDocument();
    conversationEventSource()!.emitConversation(conversation({
      activeTurnId: runningTurn.id,
      turns: [runningTurn],
      revision: 0,
      updatedAt: "2026-07-14T09:59:00.000Z",
    }));
    expect(screen.getByText("正在流式输出第一段")).toBeInTheDocument();

    const completed = conversation({ turns: [turn()], activeTurnId: null, revision: 2 });
    const firstSource = conversationEventSource()!;
    firstSource.emitConversation(completed);
    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
    expect(input).toHaveValue("下一轮请给出三个标题");
    await waitFor(() => expect(firstSource.closed).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(MockEventSource.instances.filter((source) => source.url.includes("/api/ai-conversations/")).length).toBe(2));
    const secondSource = conversationEventSource()!;
    expect(secondSource).not.toBe(firstSource);
    const secondRunning = current()!;
    const secondCompleted = {
      ...secondRunning,
      activeTurnId: null,
      revision: secondRunning.revision + 1,
      turns: secondRunning.turns.map((item: any) => item.id === secondRunning.activeTurnId
        ? { ...item, status: "completed", assistantText: "这里有三个标题。", outputSha256: "output-two", completedAt: NOW }
        : item),
    };
    firstSource.emitConversation({ ...secondCompleted, turns: [...secondCompleted.turns, turn({ id: "stale-turn", assistantText: "不应出现的旧连接消息" })] });
    expect(screen.queryByText("不应出现的旧连接消息")).not.toBeInTheDocument();
    secondSource.emitConversation(secondCompleted);
    expect(await screen.findByText("这里有三个标题。")).toBeInTheDocument();
  });

  it("loads the newest conversation after a 409 without discarding the unsent draft", async () => {
    const initial = conversation();
    const { fetchMock } = setupFetch({ initialConversation: initial, conflictTurnOnce: true });
    renderPage("/ai?conversationId=conversation-1");

    const input = await screen.findByRole("textbox", { name: "继续提问" });
    fireEvent.change(input, { target: { value: "保留这条待发送内容" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("会话已在其他页面更新，已载入最新状态。请核对后重试。");
    expect(input).toHaveValue("保留这条待发送内容");
    expect(input).toBeDisabled();
    expect(screen.queryByRole("button", { name: "结束会话" })).not.toBeInTheDocument();

    const conversationCalls = fetchMock.mock.calls
      .filter(([path]) => String(path).startsWith("/api/ai-conversations/conversation-1"))
      .map(([path, init]) => ({
        path: String(path),
        method: (init as RequestInit | undefined)?.method ?? "GET",
      }));
    expect(conversationCalls).toEqual(expect.arrayContaining([
      { path: "/api/ai-conversations/conversation-1/turns", method: "POST" },
      { path: "/api/ai-conversations/conversation-1", method: "GET" },
    ]));
  });

  it("does not submit an unfinished Chinese IME composition", async () => {
    const { fetchMock } = setupFetch();
    renderPage();
    const input = await screen.findByRole("textbox", { name: "继续提问" });
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "测试中文" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", keyCode: 229, isComposing: true });
    expect(fetchMock.mock.calls.filter(([path, init]) => String(path) === "/api/ai-conversations" && (init as RequestInit | undefined)?.method === "POST")).toHaveLength(0);
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(fetchMock.mock.calls.filter(([path, init]) => String(path) === "/api/ai-conversations" && (init as RequestInit | undefined)?.method === "POST")).toHaveLength(1));
  });

  it("keeps unsent drafts isolated when switching between a conversation and a new chat", async () => {
    setupFetch({ initialConversation: conversation() });
    renderPage("/ai?conversationId=conversation-1");

    const originalInput = await screen.findByRole("textbox", { name: "继续提问" });
    fireEvent.change(originalInput, { target: { value: "只属于原会话的草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "新会话" }));
    expect(screen.getByRole("textbox", { name: "继续提问" })).toHaveValue("");

    fireEvent.click(screen.getByRole("button", { name: "历史会话" }));
    fireEvent.click(await screen.findByRole("button", { name: /帮我判断这个方向/ }));
    expect(await screen.findByRole("textbox", { name: "继续提问" })).toHaveValue("只属于原会话的草稿");
  });

  it("isolates new-chat drafts by provider and preserves them after visiting history", async () => {
    setupFetch({ initialConversation: conversation() });
    renderPage();

    const provider = await screen.findByRole("combobox", { name: "选择 AI" });
    const input = screen.getByRole("textbox", { name: "继续提问" });
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.change(input, { target: { value: "只属于 Kimi 的草稿" } });
    fireEvent.change(provider, { target: { value: "codex" } });
    expect(screen.getByRole("textbox", { name: "继续提问" })).toHaveValue("");
    fireEvent.change(screen.getByRole("textbox", { name: "继续提问" }), { target: { value: "只属于 Codex 的草稿" } });
    fireEvent.change(provider, { target: { value: "kimi" } });
    expect(screen.getByRole("textbox", { name: "继续提问" })).toHaveValue("只属于 Kimi 的草稿");

    fireEvent.click(screen.getByRole("button", { name: "历史会话" }));
    fireEvent.click(await screen.findByRole("button", { name: /帮我判断这个方向/ }));
    fireEvent.click(await screen.findByRole("button", { name: "新会话" }));
    expect(screen.getByRole("textbox", { name: "继续提问" })).toHaveValue("只属于 Kimi 的草稿");
  });

  it("does not show a stale selected context for a history conversation whose context is null", async () => {
    setupFetch({ initialConversation: conversation({ context: null }) });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "资料" }));
    fireEvent.change(screen.getByRole("combobox", { name: "任务资料" }), {
      target: { value: workbenchIndexFixture.contents[0].id },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加资料" }));
    expect(screen.getByRole("button", { name: new RegExp(workbenchIndexFixture.contents[0].title) })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "历史会话" }));
    fireEvent.click(await screen.findByRole("button", { name: /帮我判断这个方向/ }));
    await waitFor(() => expect(screen.queryByRole("button", { name: new RegExp(workbenchIndexFixture.contents[0].title) })).not.toBeInTheDocument());
  });

  it("blocks sending for a permission decision, focuses the first action, and resumes once", async () => {
    const pending = {
      id: "permission-1",
      turnId: "turn-1",
      toolCallId: "tool-1",
      title: "请求更新一份内容资料",
      scope: ["/etc/hosts", "[会话工作区]/稿件/公众号草稿.md"],
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
      createdAt: NOW,
      expiresAt: "2026-07-14T11:00:00.000Z",
    };
    const waitingTurn = turn({ status: "waiting_permission", assistantText: "", outputSha256: null, completedAt: null });
    const initial = conversation({ activeTurnId: waitingTurn.id, turns: [waitingTurn], permissionMode: "ask", pendingPermission: pending });
    const { fetchMock } = setupFetch({ initialConversation: initial });
    renderPage("/ai?conversationId=conversation-1");

    const allow = await screen.findByRole("button", { name: "允许一次" });
    await waitFor(() => expect(allow).toHaveFocus());
    const scope = screen.getByRole("list", { name: "本次操作范围" });
    expect(scope).toHaveTextContent("/etc/hosts");
    expect(scope).toHaveTextContent("[会话工作区]/稿件/公众号草稿.md");
    expect(scope).not.toHaveTextContent("本地文件");
    expect(screen.getByRole("textbox", { name: "继续提问" })).toBeDisabled();
    fireEvent.click(allow);
    await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => String(path).includes("/permissions/permission-1"))).toBe(true));
    expect(screen.queryByText("需要你的确认")).not.toBeInTheDocument();
  });

  it("cancels a running turn without discarding the typed draft", async () => {
    const runningTurn = turn({ status: "running", assistantText: "", outputSha256: null, completedAt: null });
    setupFetch({ initialConversation: conversation({ activeTurnId: runningTurn.id, turns: [runningTurn] }) });
    renderPage("/ai?conversationId=conversation-1");

    const input = await screen.findByRole("textbox", { name: "继续提问" });
    fireEvent.change(input, { target: { value: "先保留这条草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "停止回复" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
    expect(input).toHaveValue("先保留这条草稿");
  });

  it("announces a running assistant response as a polite live region", async () => {
    const runningTurn = turn({ status: "running", assistantText: "正在形成第一段", outputSha256: null, completedAt: null });
    setupFetch({ initialConversation: conversation({ activeTurnId: runningTurn.id, turns: [runningTurn] }) });
    renderPage("/ai?conversationId=conversation-1");

    const text = await screen.findByText("正在形成第一段");
    const assistant = text.closest(".ai-assistant-message");
    expect(assistant).toHaveAttribute("aria-live", "polite");
    expect(assistant).toHaveAttribute("aria-atomic", "false");
  });

  it("explains that a closed conversation cannot receive more messages", async () => {
    setupFetch({ initialConversation: conversation({ status: "closed" }) });
    renderPage("/ai?conversationId=conversation-1");

    expect(await screen.findByRole("textbox", { name: "继续提问" })).toHaveAttribute(
      "placeholder",
      "这次会话已结束，可新建会话继续",
    );
  });

  it("requires adopting a completed reply before import and keeps the conversation open afterwards", async () => {
    const { fetchMock } = setupFetch({ initialConversation: conversation() });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPage("/ai?conversationId=conversation-1");

    expect(await screen.findByRole("button", { name: /采用这一版 V1/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "确认保存到 Obsidian" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /采用这一版 V1/ }));
    const save = await screen.findByRole("button", { name: "确认保存到 Obsidian" });
    fireEvent.click(save);
    expect(confirm).toHaveBeenCalledWith("确认将已采用的最终成果保存到 Obsidian 吗？");
    expect(await screen.findByRole("button", { name: "已保存 · 打开查看" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "继续提问" })).toBeEnabled();
    expect(fetchMock.mock.calls.some(([path]) => String(path).endsWith("/import"))).toBe(true);
  });

  it("restores a conversation on refresh, exposes history, and closes only after confirmation", async () => {
    const initial = conversation({ context: null });
    const { fetchMock } = setupFetch({ initialConversation: initial });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPage("/ai?conversationId=conversation-1");

    expect(await screen.findByText(initial.turns[0].assistantText)).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([path, init]) => String(path) === "/api/ai-conversations/conversation-1" && !(init as RequestInit | undefined)?.method)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "历史会话" }));
    const history = await screen.findByRole("region", { name: "历史会话" });
    expect(within(history).getByText(initial.turns[0].userText)).toBeInTheDocument();
    fireEvent.click(within(history).getByRole("button", { name: "关闭详情" }));

    fireEvent.click(screen.getByRole("button", { name: "结束会话" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "继续提问" })).toBeDisabled());
    expect(confirm).toHaveBeenCalledWith("确认结束这次会话吗？结束后仍可查看，但不能继续发送。");
    expect(fetchMock.mock.calls.some(([path]) => String(path).endsWith("/close"))).toBe(true);
  });

  it("renders assistant Markdown without executable HTML or unsafe links", async () => {
    const markdown = [
      "## 建议结构",
      "",
      "- 先验证问题",
      "- 再决定投入",
      "",
      "[参考资料](https://example.com/guide)",
      "[危险链接](javascript:alert(1))",
      "![远程图](https://tracker.example/pixel.png)",
      "<script>window.__unsafe = true</script>",
    ].join("\n");
    setupFetch({ initialConversation: conversation({ turns: [turn({ assistantText: markdown })] }) });
    renderPage("/ai?conversationId=conversation-1");

    expect(await screen.findByRole("heading", { name: "建议结构" })).toBeInTheDocument();
    expect(screen.getByText("先验证问题")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "参考资料" })).toHaveAttribute("href", "https://example.com/guide");
    expect(screen.getByText("危险链接").tagName).toBe("SPAN");
    expect(screen.getByText("图片：远程图")).toBeInTheDocument();
    expect(screen.queryByText(/window\.__unsafe/)).not.toBeInTheDocument();
    expect(document.querySelector('img[src="https://tracker.example/pixel.png"]')).not.toBeInTheDocument();
  });

  it("keeps a failed first-message draft for retry and has the desktop single-chat structure", async () => {
    const { fetchMock } = setupFetch({ failCreateOnce: true });
    const view = renderPage();
    const input = await screen.findByRole("textbox", { name: "继续提问" });
    fireEvent.change(input, { target: { value: "这条消息失败后不能丢" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(await screen.findByText("暂时无法开始会话")).toBeInTheDocument();
    expect(input).toHaveValue("这条消息失败后不能丢");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([path, init]) => String(path) === "/api/ai-conversations" && (init as RequestInit | undefined)?.method === "POST")).toHaveLength(2));
    const createBodies = fetchMock.mock.calls
      .filter(([path, init]) => String(path) === "/api/ai-conversations" && (init as RequestInit | undefined)?.method === "POST")
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
    expect(createBodies[0].clientRequestId).toBeTruthy();
    expect(createBodies[1].clientRequestId).toBe(createBodies[0].clientRequestId);
    expect(input).toHaveValue("");
    expect(view.container.querySelector('[data-layout="conversation"]')).toBeInTheDocument();
    expect(view.container.querySelector(".ai-message-scroll")).toBeInTheDocument();
    expect(view.container.querySelector(".ai-conversation-composer")).toBeInTheDocument();
    expect(view.container.querySelector(".ai-outcome-panel")).not.toBeInTheDocument();
  });

  it("allows a task entry without an attached asset to start a normal free conversation", async () => {
    const sourceTask = { id: "task-without-context", title: "梳理今天的内容方向", done: false, linkType: null, linkId: null };
    const { fetchMock } = setupFetch({ dailyTasks: [sourceTask] });
    renderPage(`/ai?taskId=${sourceTask.id}`);

    const input = await screen.findByRole("textbox", { name: "继续提问" });
    fireEvent.change(input, { target: { value: "先自由讨论，不附资料" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => {
      const request = fetchMock.mock.calls.find(([path, init]) => String(path) === "/api/ai-conversations" && (init as RequestInit | undefined)?.method === "POST");
      const body = JSON.parse(String((request?.[1] as RequestInit).body));
      expect(body.message).toBe("先自由讨论，不附资料");
      expect(body).not.toHaveProperty("context");
      expect(body).not.toHaveProperty("sourceTaskId");
    });
  });

  it("blocks sending until a requested conversation has finished restoring", async () => {
    const gate = deferred();
    const { fetchMock } = setupFetch({ initialConversation: conversation(), conversationGate: gate.promise });
    renderPage("/ai?conversationId=conversation-1");

    const input = await screen.findByRole("textbox", { name: "继续提问" });
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute("placeholder", "正在恢复会话…");
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(fetchMock.mock.calls.filter(([path, init]) => String(path) === "/api/ai-conversations" && (init as RequestInit | undefined)?.method === "POST")).toHaveLength(0);

    gate.resolve();
    expect(await screen.findByText("建议先验证真实用户问题，再决定是否扩大投入。")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("textbox", { name: "继续提问" })).toBeEnabled());
  });

  it("blocks task chat until the source task has been loaded and validated", async () => {
    const gate = deferred();
    const sourceTask = { id: "task-delayed", title: "梳理今天的内容方向", done: false, linkType: null, linkId: null };
    const { fetchMock } = setupFetch({ dailyTasks: [sourceTask], dailyTasksGate: gate.promise });
    renderPage(`/ai?taskId=${sourceTask.id}`);

    const input = await screen.findByRole("textbox", { name: "继续提问" });
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute("placeholder", "正在读取任务…");
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(fetchMock.mock.calls.filter(([path, init]) => String(path) === "/api/ai-conversations" && (init as RequestInit | undefined)?.method === "POST")).toHaveLength(0);

    gate.resolve();
    await waitFor(() => expect(input).toBeEnabled());
  });

  it("reuses a stable client request id when retrying a failed follow-up turn", async () => {
    const { fetchMock } = setupFetch({ initialConversation: conversation(), failTurnOnce: true });
    renderPage("/ai?conversationId=conversation-1");

    const input = await screen.findByRole("textbox", { name: "继续提问" });
    fireEvent.change(input, { target: { value: "失败后继续发送同一条" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(await screen.findByText("消息暂时没有送达")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([path, init]) => String(path).endsWith("/turns") && (init as RequestInit | undefined)?.method === "POST")).toHaveLength(2));
    const turnBodies = fetchMock.mock.calls
      .filter(([path, init]) => String(path).endsWith("/turns") && (init as RequestInit | undefined)?.method === "POST")
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
    expect(turnBodies[0].clientRequestId).toBeTruthy();
    expect(turnBodies[1].clientRequestId).toBe(turnBodies[0].clientRequestId);
  });
});
