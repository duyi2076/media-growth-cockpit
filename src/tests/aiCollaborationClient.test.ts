import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAiRun,
  cancelAiRun,
  getAiAgents,
  getAiRuns,
  importAiRun,
  isAiAgentRunnable,
  respondAiPermission,
  startAiEnvironmentAction,
} from "@/data/aiCollaborationClient";

const agentsResponse = {
  agents: [
    {
      id: "kimi",
      displayName: "Kimi Code",
      installed: true,
      version: "0.23.6",
      latestStable: "0.23.6",
      testedVersion: "0.23.6",
      versionStatus: "current",
      acpMode: "native",
      status: "ready",
      authStatus: "unknown",
      officialSource: "https://moonshotai.github.io/kimi-code/en/guides/getting-started.html",
      actions: { canInstall: true, canUpdate: true, canLogin: true },
    },
    {
      id: "codex",
      displayName: "Codex",
      installed: true,
      version: "0.144.1",
      latestStable: "0.144.3",
      testedVersion: "0.144.3",
      versionStatus: "outdated",
      acpMode: "adapter",
      status: "adapter_required",
      authStatus: "unknown",
      officialSource: "https://help.openai.com/en/articles/11096431",
      actions: { canInstall: true, canUpdate: true, canLogin: true },
      adapter: {
        packageName: "@agentclientprotocol/codex-acp",
        installed: false,
        version: null,
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

const completedRun = {
  id: "run-1",
  provider: "kimi",
  status: "completed",
  templateId: "draft-article",
  context: { type: "topic", id: "topic-1", title: "AI 工具选题", summary: "帮助新手做选择" },
  permissionMode: "readonly",
  instruction: "给出三个结构",
  finalText: "已整理三个结构。",
  pendingPermission: null,
  events: [
    { seq: 1, id: "event-1", type: "message", createdAt: "2026-07-14T10:00:00.000Z", text: "处理中" },
  ],
  error: null,
  createdAt: "2026-07-14T10:00:00.000Z",
  updatedAt: "2026-07-14T10:01:00.000Z",
};

afterEach(() => vi.unstubAllGlobals());

describe("AI collaboration client", () => {
  it("parses agent capability state and only enables a ready provider", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify(agentsResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getAiAgents();
    expect(result.agents).toHaveLength(2);
    expect(isAiAgentRunnable(result.agents[0])).toBe(true);
    expect(isAiAgentRunnable(result.agents[1])).toBe(false);
    await getAiAgents(undefined, { refresh: true });
    expect(fetchMock.mock.calls[1][0]).toBe("/api/ai-agents?refresh=1");
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ headers: { "X-Cockpit-CSRF": "1" } });
  });

  it("starts only a typed environment action and never sends a shell command", async () => {
    const job = {
      id: "ai-env-11111111-1111-4111-8111-111111111111",
      provider: "antigravity",
      action: "install",
      status: "queued",
      message: "等待处理",
      createdAt: "2026-07-14T10:00:00.000Z",
      updatedAt: "2026-07-14T10:00:00.000Z",
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ job }), {
      status: 202,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(startAiEnvironmentAction("antigravity", "install")).resolves.toMatchObject(job);
    expect(fetchMock).toHaveBeenCalledWith("/api/ai-environment/actions", expect.objectContaining({
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Cockpit-CSRF": "1" },
    }));
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ provider: "antigravity", action: "install" });
  });

  it("rejects malformed agent responses instead of guessing availability", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ...agentsResponse,
      agents: [{ ...agentsResponse.agents[0], status: "maybe" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    await expect(getAiAgents()).rejects.toMatchObject({
      message: "AI 状态服务返回的数据格式不正确",
    });
  });

  it("sends the selected task contract without putting instructions in a shell command", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ run: completedRun }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await createAiRun({
      provider: "kimi",
      templateId: "draft-article",
      context: { type: "topic", id: "topic-1" },
      permissionMode: "readonly",
      instruction: "给出三个结构",
    });

    expect(result.finalText).toBe("已整理三个结构。");
    expect(fetchMock).toHaveBeenCalledWith("/api/ai-runs", expect.objectContaining({
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Cockpit-CSRF": "1" },
    }));
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      provider: "kimi",
      templateId: "draft-article",
      context: { type: "topic", id: "topic-1" },
      permissionMode: "readonly",
      instruction: "给出三个结构",
    });
  });

  it("parses run events and rejects unknown core event types", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ runs: [completedRun] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        runs: [{ ...completedRun, events: [{ ...completedRun.events[0], type: "raw_terminal" }] }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getAiRuns()).resolves.toMatchObject({ runs: [{ id: "run-1" }] });
    await expect(getAiRuns()).rejects.toThrow("AI 运行服务返回的列表格式不正确");
  });

  it("submits one-time permission decisions and confirmed imports to scoped endpoints", async () => {
    const importedRun = {
      ...completedRun,
      importedAt: "2026-07-14T10:02:00.000Z",
      importedRelativePath: "outputs/AI-result.md",
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ run: completedRun }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ run: importedRun }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ run: completedRun }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await respondAiPermission("run-1", "permission-1", "allow-once");
    await expect(importAiRun("run-1")).resolves.toMatchObject({ importedAt: "2026-07-14T10:02:00.000Z" });
    await cancelAiRun("run-1");

    expect(fetchMock.mock.calls[0][0]).toBe("/api/ai-runs/run-1/permissions/permission-1");
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({ optionId: "allow-once" });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      headers: { "Content-Type": "application/json", "X-Cockpit-CSRF": "1" },
    });
    expect(fetchMock.mock.calls[1][0]).toBe("/api/ai-runs/run-1/import");
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "POST", headers: { "X-Cockpit-CSRF": "1" } });
    expect(fetchMock.mock.calls[2][0]).toBe("/api/ai-runs/run-1/cancel");
    expect(fetchMock.mock.calls[2][1]).toMatchObject({ method: "POST", headers: { "X-Cockpit-CSRF": "1" } });
  });
});
