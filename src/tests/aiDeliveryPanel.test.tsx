import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AiDeliveryPanel } from "@/components/ai/AiDeliveryPanel";
import type { AiRun, AiTaskLinkType } from "@/data/aiCollaborationClient";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function runFor(linkType: AiTaskLinkType): AiRun {
  return {
    id: `run-${linkType}`,
    provider: "kimi",
    status: "completed",
    templateId: linkType === "account-breakdown"
      ? "analyze-account"
      : linkType === "daily-review"
        ? "review-day"
        : linkType === "content-review"
          ? "review-content"
          : "draft-article",
    context: {
      type: linkType === "task" ? "content" : linkType,
      id: `asset-${linkType}`,
      title: `来源 ${linkType}`,
    },
    sourceTask: {
      id: `task-${linkType}`,
      date: "2026-07-14",
      title: `处理 ${linkType}`,
      linkType,
      linkId: `asset-${linkType}`,
    },
    deliveries: [],
    permissionMode: "readonly",
    instruction: "",
    finalText: "AI 已经完成了可交付的正文。",
    pendingPermission: null,
    importedAt: null,
    importedRelativePath: null,
    events: [],
    error: null,
    createdAt: "2026-07-14T10:00:00.000Z",
    updatedAt: "2026-07-14T10:01:00.000Z",
  };
}

function offeredKinds() {
  return screen.queryAllByRole("radio").map((item) => item.parentElement?.textContent ?? "");
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AI 成果交付矩阵", () => {
  it.each([
    ["topic", ["内容草稿", "复盘草稿"]],
    ["content", ["内容草稿", "复盘草稿"]],
    ["content-review", ["复盘草稿", "次日任务"]],
    ["account-breakdown", ["复盘草稿", "次日任务"]],
    ["daily-review", ["次日任务"]],
  ] as const)("only offers valid targets for %s", (linkType, expected) => {
    render(<AiDeliveryPanel run={runFor(linkType)} onDelivered={vi.fn()} />);
    expect(offeredKinds()).toEqual(expected);
  });

  it("does not expose a delivery route for a project-task relation", () => {
    render(<AiDeliveryPanel run={runFor("task")} onDelivered={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("当前来源类型不支持业务成果交付");
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
  });

  it("allows a review draft without a manual summary and omits the empty field", async () => {
    const run = runFor("content-review");
    const delivery = {
      id: "delivery-review-1",
      kind: "review_draft",
      status: "completed",
      sourceRunId: run.id,
      sourceTaskId: run.sourceTask!.id,
      targetType: "review",
      targetId: "review-1",
      targetRelativePath: "60-数据与看板/04-实验记录/review-1.md",
      targetTitle: "内容复盘草稿",
      createdAt: "2026-07-14T10:02:00.000Z",
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json({ delivery }, 201));
    vi.stubGlobal("fetch", fetchMock);
    const onDelivered = vi.fn();
    render(<AiDeliveryPanel run={run} onDelivered={onDelivered} />);

    fireEvent.change(screen.getByRole("textbox", { name: "摘要（可选）" }), { target: { value: "" } });
    const preview = screen.getByRole("button", { name: "预览成果" });
    expect(preview).toBeEnabled();
    fireEvent.click(preview);
    fireEvent.click(screen.getByRole("button", { name: "确认写入" }));

    await waitFor(() => expect(onDelivered).toHaveBeenCalledTimes(1));
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body).toMatchObject({ kind: "review_draft", reviewKind: "content-review" });
    expect(body).not.toHaveProperty("summary");
  });
});
