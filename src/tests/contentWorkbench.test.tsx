import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import { ContentPage } from "@/app/pages/ContentPage";
import { WorkbenchIndexProvider } from "@/data/adapter";
import type { ContentAssetSnapshot } from "@/data/contentAssetsClient";
import type { ContentItem, ContentStatus } from "@/types";
import { workbenchIndexFixture } from "./fixtures/workbenchIndex";

const indexData = workbenchIndexFixture;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function content(overrides: Partial<ContentItem>): ContentItem {
  return { ...indexData.contents[0], ...overrides };
}

function snapshots(items: ContentItem[] = indexData.contents): ContentAssetSnapshot[] {
  return items.map((item, index) => ({
    id: item.id,
    title: item.title,
    status: item.status,
    format: item.format,
    channels: item.channels,
    priority: item.priority,
    dueAt: item.dueAt,
    nextAction: item.nextAction,
    completedAt: null,
    publicationRecords: [],
    hash: String(index + 1).repeat(64),
    updatedAt: item.updatedAt,
  }));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("内容工作台 2.0", () => {
  it("只保留选题、发布、复盘三个阶段", async () => {
    const emptyIndex = { ...indexData, contents: [] };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/content-assets")) {
        return json({ items: [], generatedAt: "2026-07-12T10:00:00.000Z" });
      }
      return json(emptyIndex);
    }));

    render(
      <WorkbenchIndexProvider initialData={emptyIndex}>
        <BrowserRouter><ContentPage /></BrowserRouter>
      </WorkbenchIndexProvider>,
    );

    expect(screen.getByRole("heading", { name: "内容工作台" })).toBeInTheDocument();
    await screen.findByText("这里还没有内容");
    const summary = screen.getByLabelText("内容流水线摘要");
    expect(summary).toHaveTextContent("选题");
    expect(summary).toHaveTextContent("发布");
    expect(summary).toHaveTextContent("复盘");
    expect(screen.queryByRole("heading", { name: "制作" })).not.toBeInTheDocument();
    expect(screen.queryByText(/调研中|创作中/)).not.toBeInTheDocument();
    expect(screen.queryByText("来源文件")).not.toBeInTheDocument();
    expect(screen.queryByText(/本地新增|演示模式|只读连接/)).not.toBeInTheDocument();
  });

  it("新建选题通过受控接口保存", async () => {
    let postBody: Record<string, unknown> | null = null;
    let idempotencyKey: string | null = null;
    const base = snapshots();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/content-assets") && init?.method === "POST") {
        postBody = JSON.parse(String(init.body));
        idempotencyKey = new Headers(init.headers).get("X-Idempotency-Key");
        return json({
          id: "content-20260712-created",
          title: "AI 应用新选题",
          status: "候选选题" as ContentStatus,
          format: "文章",
          channels: ["公众号"],
          priority: null,
          dueAt: null,
          nextAction: "完成选题判断",
          completedAt: null,
          publicationRecords: [],
          hash: "f".repeat(64),
          updatedAt: "2026-07-12",
        }, 201);
      }
      if (url.includes("/api/content-assets")) {
        return json({ items: base, generatedAt: "2026-07-12T10:00:00.000Z" });
      }
      return json(indexData);
    }));

    render(
      <WorkbenchIndexProvider initialData={indexData}>
        <BrowserRouter><ContentPage /></BrowserRouter>
      </WorkbenchIndexProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "新建选题" }));
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "AI 应用新选题" } });
    fireEvent.click(screen.getByRole("button", { name: "保存选题" }));

    await waitFor(() => expect(postBody).not.toBeNull());
    expect(postBody).toMatchObject({
      title: "AI 应用新选题",
      status: "候选选题",
      format: "文章",
      channels: ["公众号"],
    });
    expect(idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("新建选题响应丢失后重试复用同一幂等编号，并找回已保存的原请求", async () => {
    const keys: Array<string | null> = [];
    let postCalls = 0;
    const recovered: ContentAssetSnapshot = {
      id: "content-20260712-replayed",
      title: "网络重试选题",
      status: "候选选题",
      format: "文章",
      channels: ["公众号"],
      priority: null,
      dueAt: null,
      nextAction: "完成选题判断",
      completedAt: null,
      publicationRecords: [],
      hash: "e".repeat(64),
      updatedAt: "2026-07-12",
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/content-assets") && init?.method === "POST") {
        postCalls += 1;
        keys.push(new Headers(init.headers).get("X-Idempotency-Key"));
        if (postCalls === 1) throw new TypeError("response lost");
        return json({ error: "conflict", current: recovered }, 409);
      }
      if (url.includes("/api/content-assets")) return json({ items: [], generatedAt: "2026-07-12T10:00:00.000Z" });
      return json({ ...indexData, contents: [] });
    }));

    render(
      <WorkbenchIndexProvider initialData={{ ...indexData, contents: [] }}>
        <BrowserRouter><ContentPage /></BrowserRouter>
      </WorkbenchIndexProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "新建选题" }));
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "网络重试选题" } });
    fireEvent.click(screen.getByRole("button", { name: "保存选题" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("无法确认保存结果");
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "网络重试选题（补充）" } });
    fireEvent.click(screen.getByRole("button", { name: "保存选题" }));
    await waitFor(() => expect(postCalls).toBe(2));
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    expect(await screen.findByRole("alert")).toHaveTextContent("已找回首次保存的选题");
    expect(screen.getByRole("region", { name: "网络重试选题" })).toBeInTheDocument();
    expect(screen.queryByDisplayValue("网络重试选题（补充）")).not.toBeInTheDocument();
  });

  it("迟到的读取成功不会清除刚发生的保存错误", async () => {
    let resolveInitialRead!: (value: Response) => void;
    const initialRead = new Promise<Response>((resolve) => { resolveInitialRead = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/content-assets") && init?.method === "POST") {
        return json({ error: "invalid_request", message: "选题保存失败，请修正后重试" }, 400);
      }
      if (url.includes("/api/content-assets")) return initialRead;
      return json({ ...indexData, contents: [] });
    }));

    render(
      <WorkbenchIndexProvider initialData={{ ...indexData, contents: [] }}>
        <BrowserRouter><ContentPage /></BrowserRouter>
      </WorkbenchIndexProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "新建选题" }));
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "保存错误不能被覆盖" } });
    fireEvent.click(screen.getByRole("button", { name: "保存选题" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("选题保存失败，请修正后重试");

    resolveInitialRead(json({ items: [], generatedAt: "2026-07-12T10:00:00.000Z" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("选题保存失败，请修正后重试"));
  });

  it("默认工作台和摘要排除归档，选择已归档后进入专门列表", async () => {
    const active = content({ id: "content-active", title: "进行中的选题", status: "候选选题", evidenceStatus: "待补充" });
    const archived = content({ id: "content-archived", title: "已经归档的选题", status: "已归档", evidenceStatus: "待补充" });
    const customIndex = { ...indexData, contents: [active, archived] };
    const apiItems = snapshots(customIndex.contents);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/content-assets")) {
        return json({ items: apiItems, generatedAt: "2026-07-12T10:00:00.000Z" });
      }
      return json(customIndex);
    }));

    render(
      <WorkbenchIndexProvider initialData={customIndex}>
        <BrowserRouter><ContentPage /></BrowserRouter>
      </WorkbenchIndexProvider>,
    );

    expect(await screen.findByText("进行中的选题")).toBeInTheDocument();
    expect(screen.queryByText("已经归档的选题")).not.toBeInTheDocument();
    expect(screen.getByLabelText("内容流水线摘要")).toHaveTextContent("复盘0");

    fireEvent.change(screen.getByRole("combobox", { name: "当前状态" }), { target: { value: "已归档" } });
    expect(await screen.findByRole("heading", { name: "归档内容" })).toBeInTheDocument();
    expect(screen.getByText("已经归档的选题")).toBeInTheDocument();
    expect(screen.queryByText("进行中的选题")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("内容工作流看板")).not.toBeInTheDocument();
  });

  it("移入归档必须二次确认，保存失败时显示后端错误", async () => {
    const active = content({ id: "content-to-archive", title: "准备归档的选题", status: "候选选题", evidenceStatus: "待补充" });
    const customIndex = { ...indexData, contents: [active] };
    const apiItems = snapshots(customIndex.contents);
    let putCalls = 0;
    let putStatus: ContentStatus | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/content-assets") && init?.method === "PUT") {
        putCalls += 1;
        putStatus = (JSON.parse(String(init.body)) as { patch: { status?: ContentStatus } }).patch.status;
        return json({ error: "invalid_request", message: "模拟归档失败" }, 400);
      }
      if (String(input).includes("/api/content-assets")) {
        return json({ items: apiItems, generatedAt: "2026-07-12T10:00:00.000Z" });
      }
      return json(customIndex);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <WorkbenchIndexProvider initialData={customIndex}>
        <BrowserRouter><ContentPage /></BrowserRouter>
      </WorkbenchIndexProvider>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    fireEvent.click(screen.getByText("准备归档的选题"));
    fireEvent.click(await screen.findByRole("button", { name: "移入归档" }));
    expect(putCalls).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "确认移入归档" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("模拟归档失败");
    expect(putCalls).toBe(1);
    expect(putStatus).toBe("已归档");
  });

  it("归档内容按发布证据恢复到候选选题或待复盘", async () => {
    const unverified = content({ id: "content-restore-idea", title: "恢复为候选", status: "已归档", evidenceStatus: "待补充" });
    const verified = content({ id: "content-restore-review", title: "恢复为复盘", status: "已归档", evidenceStatus: "有证据" });
    const customIndex = { ...indexData, contents: [unverified, verified] };
    let apiItems = snapshots(customIndex.contents);
    const patches: Array<{ id: string; status?: ContentStatus }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/content-assets") && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { id: string; patch: { status?: ContentStatus } };
        patches.push({ id: body.id, status: body.patch.status });
        const current = apiItems.find((item) => item.id === body.id)!;
        const saved = { ...current, ...body.patch, hash: "f".repeat(64) };
        apiItems = apiItems.map((item) => item.id === saved.id ? saved : item);
        return json(saved);
      }
      if (String(input).includes("/api/content-assets")) {
        return json({ items: apiItems, generatedAt: "2026-07-12T10:00:00.000Z" });
      }
      return json(customIndex);
    });
    vi.stubGlobal("fetch", fetchMock);

    const view = render(
      <WorkbenchIndexProvider initialData={customIndex}>
        <BrowserRouter><ContentPage /></BrowserRouter>
      </WorkbenchIndexProvider>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    fireEvent.change(screen.getByRole("combobox", { name: "当前状态" }), { target: { value: "已归档" } });
    fireEvent.click(await screen.findByRole("button", { name: "恢复为候选" }));
    expect(await screen.findByText("恢复后将回到「候选选题」。原 Markdown 内容和发布证据都会保留。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));
    await waitFor(() => expect(patches).toContainEqual({ id: "content-restore-idea", status: "候选选题" }));

    view.unmount();
    apiItems = snapshots(customIndex.contents);
    patches.length = 0;
    render(
      <WorkbenchIndexProvider initialData={customIndex}>
        <BrowserRouter><ContentPage /></BrowserRouter>
      </WorkbenchIndexProvider>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    fireEvent.change(screen.getByRole("combobox", { name: "当前状态" }), { target: { value: "已归档" } });
    fireEvent.click(await screen.findByRole("button", { name: "恢复为复盘" }));
    expect(await screen.findByText("恢复后将回到「待复盘」。原 Markdown 内容和发布证据都会保留。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));
    await waitFor(() => expect(patches).toContainEqual({ id: "content-restore-review", status: "待复盘" }));
  });

  it("成稿确认由专门动作记录，手动状态不能伪造已发布", async () => {
    const article = content({
      id: "content-complete-article",
      title: "准备完成的文章",
      status: "待发布",
      format: "文章",
      channels: ["公众号"],
      evidenceStatus: "待补充",
    });
    const customIndex = { ...indexData, contents: [article] };
    let apiItems = snapshots(customIndex.contents);
    let completeBody: Record<string, unknown> | null = null;
    const completedAt = "2026-07-14T10:30:00+08:00";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/content-assets/complete" && init?.method === "POST") {
        completeBody = JSON.parse(String(init.body));
        const saved = { ...apiItems[0], completedAt, hash: "f".repeat(64), updatedAt: "2026-07-14" };
        apiItems = [saved];
        return json(saved);
      }
      if (url.includes("/api/content-assets")) {
        return json({ items: apiItems, generatedAt: "2026-07-14T10:30:00.000Z" });
      }
      return json(customIndex);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <WorkbenchIndexProvider initialData={customIndex}>
        <BrowserRouter><ContentPage /></BrowserRouter>
      </WorkbenchIndexProvider>,
    );

    fireEvent.click(await screen.findByText("准备完成的文章"));
    const drawer = await screen.findByRole("region", { name: "准备完成的文章" });
    const manualStatus = within(drawer).getByRole("combobox", { name: "当前状态" });
    expect(within(manualStatus).queryByRole("option", { name: /已发布/ })).not.toBeInTheDocument();
    expect(within(manualStatus).queryByRole("option", { name: "待复盘" })).not.toBeInTheDocument();

    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(within(drawer).getByRole("button", { name: "确认文章已成稿" }));
    await waitFor(() => expect(completeBody).toEqual({
      id: "content-complete-article",
      expectedHash: "1".repeat(64),
    }));
    expect(await within(drawer).findByText("已完成")).toBeInTheDocument();
    expect(within(drawer).getByText(/完成时间：/)).toHaveTextContent("2026/07/14 10:30");
  });

  it("登记真实发布会自动补成品确认，并在中文输入期间阻止误提交", async () => {
    const article = content({
      id: "content-publish-article",
      title: "准备发布的文章",
      status: "待发布",
      format: "文章",
      channels: ["公众号"],
      evidenceStatus: "待补充",
    });
    const customIndex = { ...indexData, contents: [article] };
    let apiItems = snapshots(customIndex.contents);
    let publicationBody: Record<string, unknown> | null = null;
    let publicationCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/content-assets/publications" && init?.method === "POST") {
        publicationCalls += 1;
        const requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        publicationBody = requestBody;
        const publishedAt = String(requestBody.publishedAt);
        const saved = {
          ...apiItems[0],
          status: "已发布" as ContentStatus,
          completedAt: publishedAt,
          publicationRecords: [{
            id: "publication-1",
            platform: "公众号",
            publishedAt,
            url: null,
            evidenceRef: "[[2026-07-14-公众号发布截图]]",
            verification: "已核验" as const,
          }],
          hash: "f".repeat(64),
          updatedAt: "2026-07-14",
        };
        apiItems = [saved];
        return json(saved, 201);
      }
      if (url.includes("/api/content-assets")) {
        return json({ items: apiItems, generatedAt: "2026-07-14T10:30:00.000Z" });
      }
      return json(customIndex);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <WorkbenchIndexProvider initialData={customIndex}>
        <BrowserRouter><ContentPage /></BrowserRouter>
      </WorkbenchIndexProvider>,
    );

    fireEvent.click(await screen.findByText("准备发布的文章"));
    const drawer = await screen.findByRole("region", { name: "准备发布的文章" });
    fireEvent.click(within(drawer).getByRole("button", { name: "登记发布" }));
    expect(within(drawer).getByText("登记成功后，这份内容会同时确认已形成可发布成品。")).toBeInTheDocument();

    fireEvent.click(within(drawer).getByRole("button", { name: "保存发布记录" }));
    expect(within(drawer).getByRole("alert")).toHaveTextContent("必须二选一");

    const evidenceInput = within(drawer).getByLabelText("V2 证据引用（与发布链接二选一）");
    fireEvent.compositionStart(evidenceInput);
    fireEvent.change(evidenceInput, { target: { value: "[[2026-07-14-公众号发布截图]]" } });
    fireEvent.keyDown(evidenceInput, { key: "Enter", code: "Enter", keyCode: 229, isComposing: true });
    expect(publicationCalls).toBe(0);
    fireEvent.compositionEnd(evidenceInput);
    fireEvent.click(within(drawer).getByLabelText("我确认这条内容已经真实发布，以上信息准确。"));
    fireEvent.click(within(drawer).getByRole("button", { name: "保存发布记录" }));

    await waitFor(() => expect(publicationBody).toMatchObject({
      id: "content-publish-article",
      expectedHash: "1".repeat(64),
      platform: "公众号",
      evidenceRef: "[[2026-07-14-公众号发布截图]]",
      confirmed: true,
    }));
    expect(await within(drawer).findByText("已核验")).toBeInTheDocument();
    expect(within(drawer).getByText("证据已记录")).toBeInTheDocument();
    expect(within(drawer).getByText(/由发布与复盘记录自动更新/)).toHaveTextContent("已发布");
  });
});
