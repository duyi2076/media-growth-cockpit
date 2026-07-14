import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import { DailyReviewsPage } from "@/app/pages/DailyReviewsPage";
import { WorkbenchIndexProvider } from "@/data/adapter";
import type { DailyReviewSnapshot } from "@/data/dailyReviewsClient";
import { workbenchIndexFixture } from "./fixtures/workbenchIndex";

const indexData = workbenchIndexFixture;

function snapshot(overrides: Partial<DailyReviewSnapshot> = {}): DailyReviewSnapshot {
  return {
    id: "daily-review-2026-07-14",
    date: "2026-07-14",
    todayCompleted: "完成一篇文章。",
    facts: "发布 1 篇。",
    effectiveActions: "先写结论。",
    problems: "开头偏慢。",
    judgment: "文章产量达标。",
    tomorrowAction: "重写视频前三秒。",
    confirmation: "待人工确认",
    confirmedAt: null,
    hash: "a".repeat(64),
    updatedAt: "2026-07-14T04:00:00.000Z",
    source: "60-数据与看板/05-经营看板/每日复盘/2026-07-14-每日复盘.md",
    ...overrides,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function renderPage() {
  return render(
    <WorkbenchIndexProvider initialData={indexData}>
      <BrowserRouter><DailyReviewsPage /></BrowserRouter>
    </WorkbenchIndexProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("每日复盘工作台", () => {
  it("列表卡片可直接确认，并刷新为已确认", async () => {
    let item = snapshot();
    let putBody: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/daily-reviews") && init?.method === "PUT") {
        putBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        item = { ...item, confirmation: "已确认", confirmedAt: "2026-07-14T05:00:00.000Z", hash: "b".repeat(64) };
        return json(item);
      }
      if (url.includes("/api/daily-reviews")) return json({ items: [item], generatedAt: "2026-07-14T05:00:00.000Z" });
      return json(indexData);
    }));

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "确认每日复盘：2026-07-14" }));
    await waitFor(() => expect(putBody).not.toBeNull());
    expect(putBody).toMatchObject({
      id: "daily-review-2026-07-14",
      patch: { confirmation: "已确认" },
      expectedHash: "a".repeat(64),
    });
    expect((await screen.findAllByText("已确认")).some((element) => element.tagName === "SPAN")).toBe(true);
  });

  it("迟到的每日复盘列表读取成功不会清除刚发生的保存错误", async () => {
    const item = snapshot();
    let getCalls = 0;
    let resolveLateRead!: (value: Response) => void;
    const lateRead = new Promise<Response>((resolve) => { resolveLateRead = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/daily-reviews") && init?.method === "PUT") {
        return json({ error: "invalid_request", message: "每日复盘保存失败，请修正后重试" }, 400);
      }
      if (url.includes("/api/daily-reviews")) {
        getCalls += 1;
        if (getCalls === 1) return json({ items: [item], generatedAt: "2026-07-14T05:00:00.000Z" });
        return lateRead;
      }
      return json(indexData);
    }));

    renderPage();
    expect(await screen.findByRole("button", { name: "确认每日复盘：2026-07-14" })).toBeInTheDocument();
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(getCalls).toBe(2));

    fireEvent.click(screen.getByRole("button", { name: "确认每日复盘：2026-07-14" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("每日复盘保存失败，请修正后重试");

    resolveLateRead(json({ items: [item], generatedAt: "2026-07-14T05:01:00.000Z" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("每日复盘保存失败，请修正后重试"));
  });

  it("可新建指定日期的每日复盘草稿", async () => {
    let createdBody: Record<string, unknown> | null = null;
    let idempotencyKey: string | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/daily-reviews") && init?.method === "POST") {
        idempotencyKey = new Headers(init.headers).get("X-Idempotency-Key");
        createdBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return json(snapshot({
          id: `daily-review-${createdBody.date}`,
          date: String(createdBody.date),
          todayCompleted: String(createdBody.todayCompleted),
          facts: String(createdBody.facts),
          effectiveActions: String(createdBody.effectiveActions),
          problems: String(createdBody.problems),
          judgment: String(createdBody.judgment),
          tomorrowAction: String(createdBody.tomorrowAction),
        }), 201);
      }
      if (url.includes("/api/daily-reviews")) return json({ items: [], generatedAt: "2026-07-14T05:00:00.000Z" });
      return json(indexData);
    }));

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "新建每日复盘" }));
    fireEvent.change(screen.getByLabelText("日期"), { target: { value: "2026-07-13" } });
    fireEvent.change(screen.getByLabelText("今日完成"), { target: { value: "完成两项内容" } });
    fireEvent.change(screen.getByLabelText("今日判断"), { target: { value: "节奏需要保持" } });
    fireEvent.change(screen.getByLabelText("明日最重要动作"), { target: { value: "先写文章" } });
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(createdBody).not.toBeNull());
    expect(createdBody).toMatchObject({
      date: "2026-07-13",
      todayCompleted: "完成两项内容",
      judgment: "节奏需要保持",
      tomorrowAction: "先写文章",
    });
    expect(idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
    expect(await screen.findByRole("region", { name: "2026-07-13 每日复盘" })).toBeInTheDocument();
  });

  it("新建响应丢失后重试复用同一幂等编号，并找回首次保存的每日复盘", async () => {
    const keys: Array<string | null> = [];
    let postCalls = 0;
    const recovered = snapshot({
      id: "daily-review-2026-07-13",
      date: "2026-07-13",
      todayCompleted: "首次请求已经保存",
      judgment: "保留首次请求的判断",
      tomorrowAction: "核对后继续编辑",
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/daily-reviews") && init?.method === "POST") {
        postCalls += 1;
        keys.push(new Headers(init.headers).get("X-Idempotency-Key"));
        if (postCalls === 1) throw new TypeError("response lost");
        return json({ error: "hash_conflict", current: recovered }, 409);
      }
      if (url.includes("/api/daily-reviews")) return json({ items: [], generatedAt: "2026-07-14T05:00:00.000Z" });
      return json(indexData);
    }));

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "新建每日复盘" }));
    fireEvent.change(screen.getByLabelText("日期"), { target: { value: "2026-07-13" } });
    fireEvent.change(screen.getByLabelText("今日完成"), { target: { value: "首次请求已经保存" } });
    fireEvent.change(screen.getByLabelText("今日判断"), { target: { value: "保留首次请求的判断" } });
    fireEvent.change(screen.getByLabelText("明日最重要动作"), { target: { value: "核对后继续编辑" } });
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("无法确认保存结果");

    fireEvent.change(screen.getByLabelText("今日判断"), { target: { value: "响应丢失后又修改了判断" } });
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(postCalls).toBe(2));
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    expect(await screen.findByRole("alert")).toHaveTextContent("已找回首次保存的每日复盘");
    expect(screen.getByRole("region", { name: "2026-07-13 每日复盘" })).toBeInTheDocument();
    expect(screen.getByLabelText("今日判断")).toHaveValue("保留首次请求的判断");
  });

  it("已确认复盘编辑后显示为待人工确认", async () => {
    let item = snapshot({ confirmation: "已确认", confirmedAt: "2026-07-14T05:00:00.000Z" });
    let putBody: { patch: Record<string, unknown> } | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/daily-reviews") && init?.method === "PUT") {
        putBody = JSON.parse(String(init.body)) as { patch: Record<string, unknown> };
        item = { ...item, ...putBody.patch, confirmation: "待人工确认", confirmedAt: null, hash: "b".repeat(64) };
        return json(item);
      }
      if (url.includes("/api/daily-reviews")) return json({ items: [item], generatedAt: "2026-07-14T05:00:00.000Z" });
      return json(indexData);
    }));

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "编辑每日复盘：2026-07-14" }));
    fireEvent.change(screen.getByLabelText("今日判断"), { target: { value: "编辑后的判断" } });
    fireEvent.click(screen.getByRole("button", { name: "保存修改（需重新确认）" }));
    await waitFor(() => expect(putBody).not.toBeNull());
    expect((putBody as { patch: Record<string, unknown> } | null)?.patch).toEqual({ judgment: "编辑后的判断" });
    expect((await screen.findAllByText("待人工确认")).some((element) => element.tagName === "SPAN")).toBe(true);
  });
});
