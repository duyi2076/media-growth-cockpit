import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import { ReviewsPage } from "@/app/pages/ReviewsPage";
import { WorkbenchIndexProvider } from "@/data/adapter";
import type { ReviewAssetSnapshot } from "@/data/reviewAssetsClient";
import type { ContentItem } from "@/types";
import { workbenchIndexFixture } from "./fixtures/workbenchIndex";

const content: ContentItem = {
  id: "content-one",
  familyId: "content-one",
  title: "已发布但还没有复盘的内容",
  summary: "内容摘要",
  status: "已发布",
  format: "文章",
  channels: ["公众号"],
  priority: null,
  dueAt: null,
  source: "30-内容资产/文章/content-one.md",
  nextAction: "完成复盘",
  evidenceStatus: "有证据",
  tags: ["AI"],
  updatedAt: "2026-07-13",
};

const indexData = { ...workbenchIndexFixture, contents: [content] };

function snapshot(overrides: Partial<ReviewAssetSnapshot> & Pick<ReviewAssetSnapshot, "id" | "kind" | "title">): ReviewAssetSnapshot {
  const { id, kind, title, ...rest } = overrides;
  return {
    id,
    kind,
    title,
    sourceUrl: null,
    platform: null,
    relatedContentId: null,
    summary: "",
    findings: "",
    nextAction: "",
    confirmation: "待人工确认",
    confirmedAt: null,
    hash: "a".repeat(64),
    updatedAt: "2026-07-13T03:00:00.000Z",
    source: `20-知识资产/复盘/${id}.md`,
    ...rest,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function renderPage() {
  return render(
    <WorkbenchIndexProvider initialData={indexData}>
      <BrowserRouter><ReviewsPage /></BrowserRouter>
    </WorkbenchIndexProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("复盘与对标工作台", () => {
  it("待确认卡片可直接确认，不必先打开编辑抽屉", async () => {
    let item = snapshot({
      id: "pending-direct-confirm",
      kind: "content-review",
      title: "可直接确认的内容复盘",
      sourceUrl: "https://example.com/content",
      findings: "标题承诺与正文一致。",
      nextAction: "下一篇继续使用该结构。",
    });
    let putBody: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/review-assets") && init?.method === "PUT") {
        putBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        item = { ...item, confirmation: "已确认", confirmedAt: "2026-07-14T04:00:00.000Z", hash: "b".repeat(64) };
        return json(item);
      }
      if (url.includes("/api/review-assets")) return json({ items: [item], generatedAt: "2026-07-14T04:00:00.000Z" });
      return json(indexData);
    }));

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "确认内容复盘：可直接确认的内容复盘" }));
    await waitFor(() => expect(putBody).not.toBeNull());
    expect(putBody).toMatchObject({
      id: "pending-direct-confirm",
      patch: { confirmation: "已确认" },
      expectedHash: "a".repeat(64),
    });
    expect(screen.queryByRole("region", { name: "编辑内容复盘" })).not.toBeInTheDocument();
    expect((await screen.findAllByText("已确认")).some((element) => element.tagName === "SPAN")).toBe(true);
  });

  it("迟到的复盘列表读取成功不会清除刚发生的保存错误", async () => {
    const item = snapshot({
      id: "review-write-error",
      kind: "content-review",
      title: "保存错误不能被读取覆盖",
    });
    let getCalls = 0;
    let resolveLateRead!: (value: Response) => void;
    const lateRead = new Promise<Response>((resolve) => { resolveLateRead = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/review-assets") && init?.method === "PUT") {
        return json({ error: "invalid_request", message: "复盘保存失败，请修正后重试" }, 400);
      }
      if (url.includes("/api/review-assets")) {
        getCalls += 1;
        if (getCalls === 1) return json({ items: [item], generatedAt: "2026-07-14T04:00:00.000Z" });
        return lateRead;
      }
      return json(indexData);
    }));

    renderPage();
    expect(await screen.findByText("保存错误不能被读取覆盖")).toBeInTheDocument();
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(getCalls).toBe(2));

    fireEvent.click(screen.getByRole("button", { name: "确认内容复盘：保存错误不能被读取覆盖" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("复盘保存失败，请修正后重试");

    resolveLateRead(json({ items: [item], generatedAt: "2026-07-14T04:01:00.000Z" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("复盘保存失败，请修正后重试"));
  });

  it("直接展示 review-assets 中待确认和已确认资产，不再把已发布内容冒充复盘", async () => {
    const items = [
      snapshot({ id: "pending-review", kind: "content-review", title: "真正的待确认复盘" }),
      snapshot({
        id: "confirmed-account",
        kind: "account-breakdown",
        title: "已经确认的账号拆解",
        confirmation: "已确认",
        sourceUrl: "https://example.com/account",
      }),
    ];
    let openedSource: string | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/open-obsidian")) {
        openedSource = (JSON.parse(String(init?.body)) as { source: string }).source;
        return json({ opened: true });
      }
      if (url.includes("/api/review-assets")) return json({ items, generatedAt: "2026-07-13T03:00:00.000Z" });
      return json(indexData);
    }));

    renderPage();
    expect(await screen.findByText("真正的待确认复盘")).toBeInTheDocument();
    expect(screen.getAllByText("待人工确认").some((element) => element.tagName === "SPAN")).toBe(true);
    expect(screen.queryByText("已发布但还没有复盘的内容")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("真正的待确认复盘"));
    fireEvent.click(screen.getByRole("button", { name: "打开原文" }));
    await waitFor(() => expect(openedSource).toBe("review:pending-review"));

    fireEvent.click(screen.getByRole("tab", { name: "账号拆解" }));
    expect(await screen.findByText("已经确认的账号拆解")).toBeInTheDocument();
    expect(screen.getAllByText("已确认").some((element) => element.tagName === "SPAN")).toBe(true);
    expect(screen.getByRole("button", { name: "新建账号拆解" })).toBeInTheDocument();
  });

  it("新建内容复盘时校验关联证据，支持中文输入并可 PUT 编辑确认", async () => {
    let items: ReviewAssetSnapshot[] = [];
    const requests: Array<{ method: string; body: Record<string, unknown> }> = [];
    let idempotencyKey: string | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/review-assets") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        idempotencyKey = new Headers(init.headers).get("X-Idempotency-Key");
        requests.push({ method: "POST", body });
        const created = snapshot({
          id: "created-review",
          kind: "content-review",
          title: String(body.title),
          relatedContentId: body.relatedContentId as string | null,
          summary: String(body.summary),
          findings: String(body.findings),
          nextAction: String(body.nextAction),
        });
        items = [created];
        return json(created);
      }
      if (url.includes("/api/review-assets") && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { id: string; patch: Partial<ReviewAssetSnapshot>; expectedHash: string };
        requests.push({ method: "PUT", body: body as unknown as Record<string, unknown> });
        const updated = { ...items[0], ...body.patch, hash: "b".repeat(64), updatedAt: "2026-07-13T04:00:00.000Z" };
        items = [updated];
        return json(updated);
      }
      if (url.includes("/api/review-assets")) return json({ items, generatedAt: "2026-07-13T03:00:00.000Z" });
      return json(indexData);
    }));

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "新建内容复盘" }));
    const title = screen.getByLabelText("标题");
    fireEvent.compositionStart(title);
    fireEvent.change(title, { target: { value: "第一篇内容复盘" } });
    fireEvent.keyDown(title, { key: "Enter", keyCode: 229, isComposing: true });
    expect(requests).toHaveLength(0);
    fireEvent.compositionEnd(title);

    fireEvent.click(screen.getByRole("button", { name: "保存内容复盘" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("请选择关联内容");
    expect(requests).toHaveLength(0);

    fireEvent.change(screen.getByLabelText("关联内容（与发布链接至少填一项）"), { target: { value: content.id } });
    fireEvent.change(screen.getByLabelText("复盘结论"), { target: { value: "标题承诺与正文一致" } });
    fireEvent.click(screen.getByRole("button", { name: "保存内容复盘" }));

    await waitFor(() => expect(requests.some((request) => request.method === "POST")).toBe(true));
    expect(requests.find((request) => request.method === "POST")?.body).toMatchObject({
      kind: "content-review",
      title: "第一篇内容复盘",
      relatedContentId: content.id,
      sourceUrl: null,
    });
    expect(idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
    expect((await screen.findAllByText("待人工确认")).some((element) => element.tagName === "SPAN")).toBe(true);

    const findings = screen.getByLabelText("复盘结论");
    expect(screen.getByLabelText("标题")).toBeEnabled();
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "第一篇内容复盘（修订）" } });
    fireEvent.change(findings, { target: { value: "开头需要更快进入用户问题" } });
    fireEvent.change(screen.getByLabelText("下一步动作"), { target: { value: "重写前三句话" } });
    fireEvent.click(screen.getByRole("button", { name: "确认并保存" }));

    await waitFor(() => expect(requests.some((request) => request.method === "PUT")).toBe(true));
    const put = requests.find((request) => request.method === "PUT")?.body as {
      id: string;
      patch: Record<string, unknown>;
      expectedHash: string;
    };
    expect(put.id).toBe("created-review");
    expect(put.expectedHash).toBe("a".repeat(64));
    expect(put.patch).toMatchObject({
      title: "第一篇内容复盘（修订）",
      findings: "开头需要更快进入用户问题",
      nextAction: "重写前三句话",
      confirmation: "已确认",
    });
    expect((await screen.findAllByText("已确认")).some((element) => element.tagName === "SPAN")).toBe(true);
  });

  it("新建复盘响应丢失后重试复用同一幂等编号，并找回已保存的原请求", async () => {
    const keys: Array<string | null> = [];
    let postCalls = 0;
    const recovered = snapshot({
      id: "review-replayed",
      kind: "content-review",
      title: "网络重试复盘",
      sourceUrl: "https://example.com/review-source",
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/review-assets") && init?.method === "POST") {
        postCalls += 1;
        keys.push(new Headers(init.headers).get("X-Idempotency-Key"));
        if (postCalls === 1) throw new TypeError("response lost");
        return json({ error: "conflict", current: recovered }, 409);
      }
      if (url.includes("/api/review-assets")) return json({ items: [], generatedAt: "2026-07-13T03:00:00.000Z" });
      return json(indexData);
    }));

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "新建内容复盘" }));
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "网络重试复盘" } });
    fireEvent.change(screen.getByLabelText("已发布内容链接"), { target: { value: "https://example.com/review-source" } });
    fireEvent.click(screen.getByRole("button", { name: "保存内容复盘" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("无法确认保存结果");
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "网络重试复盘（补充）" } });
    fireEvent.click(screen.getByRole("button", { name: "保存内容复盘" }));
    await waitFor(() => expect(postCalls).toBe(2));
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    expect(await screen.findByRole("alert")).toHaveTextContent("已找回首次保存的复盘");
    expect(screen.getByRole("region", { name: "编辑内容复盘" })).toBeInTheDocument();
    expect(screen.getByLabelText("标题")).toHaveValue("网络重试复盘");
  });

  it("新建账号拆解必须提供 https 账号链接", async () => {
    let createdBody: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/review-assets") && init?.method === "POST") {
        createdBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return json(snapshot({
          id: "created-account",
          kind: "account-breakdown",
          title: String(createdBody.title),
          sourceUrl: String(createdBody.sourceUrl),
          platform: "小红书",
        }));
      }
      if (url.includes("/api/review-assets")) return json({ items: [], generatedAt: "2026-07-13T03:00:00.000Z" });
      return json(indexData);
    }));

    renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: "账号拆解" }));
    fireEvent.click(screen.getByRole("button", { name: "新建账号拆解" }));
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "拆解一个优秀账号" } });

    const form = screen.getByRole("button", { name: "保存账号拆解" }).closest("form");
    if (!form) throw new Error("未找到账号拆解表单");
    fireEvent.submit(form);
    expect(await screen.findByRole("alert")).toHaveTextContent("必须填写账号或代表作品");
    expect(createdBody).toBeNull();

    fireEvent.change(screen.getByLabelText("账号或代表作品链接（必填）"), { target: { value: "http://example.com/account" } });
    fireEvent.submit(form);
    expect(await screen.findByRole("alert")).toHaveTextContent("必须使用 https://");
    expect(createdBody).toBeNull();

    fireEvent.change(screen.getByLabelText("账号或代表作品链接（必填）"), { target: { value: "https://example.com/account" } });
    fireEvent.change(screen.getByLabelText("平台（可选）"), { target: { value: "小红书" } });
    for (const indentation of ["", " ", "  ", "   "]) {
      fireEvent.change(screen.getByLabelText("背景摘要"), { target: { value: `普通文字\n${indentation}## 保留标题` } });
      fireEvent.click(screen.getByRole("button", { name: "保存账号拆解" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("不能使用「## 标题」");
      expect(createdBody).toBeNull();
    }
    fireEvent.change(screen.getByLabelText("背景摘要"), { target: { value: "" } });
    for (const label of ["拆解发现", "下一步动作"]) {
      fireEvent.change(screen.getByLabelText(label), { target: { value: "普通文字\n## 保留标题" } });
      fireEvent.click(screen.getByRole("button", { name: "保存账号拆解" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("不能使用「## 标题」");
      expect(createdBody).toBeNull();
      fireEvent.change(screen.getByLabelText(label), { target: { value: "" } });
    }
    fireEvent.click(screen.getByRole("button", { name: "保存账号拆解" }));

    await waitFor(() => expect(createdBody).not.toBeNull());
    expect(createdBody).toMatchObject({
      kind: "account-breakdown",
      sourceUrl: "https://example.com/account",
      relatedContentId: null,
      platform: "小红书",
    });
  });

  it("已确认的账号拆解仍有明确编辑入口，并可修改标题后保存", async () => {
    let item = snapshot({
      id: "confirmed-account-edit",
      kind: "account-breakdown",
      title: "已确认的账号拆解",
      confirmation: "已确认",
      sourceUrl: "https://example.com/account",
      platform: "B 站",
    });
    const putBodies: Array<{ id: string; patch: Partial<ReviewAssetSnapshot>; expectedHash: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/review-assets") && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { id: string; patch: Partial<ReviewAssetSnapshot>; expectedHash: string };
        putBodies.push(body);
        item = { ...item, ...body.patch, hash: "b".repeat(64) };
        return json(item);
      }
      if (url.includes("/api/review-assets")) return json({ items: [item], generatedAt: "2026-07-13T03:00:00.000Z" });
      return json(indexData);
    }));

    renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: "账号拆解" }));
    fireEvent.click(screen.getByRole("button", { name: "编辑账号拆解：已确认的账号拆解" }));

    const title = screen.getByLabelText("标题");
    expect(title).toBeEnabled();
    fireEvent.change(title, { target: { value: "已确认的账号拆解（修订）" } });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));

    await waitFor(() => expect(putBodies).toHaveLength(1));
    expect(putBodies[0]).toMatchObject({
      id: "confirmed-account-edit",
      expectedHash: "a".repeat(64),
      patch: { title: "已确认的账号拆解（修订）" },
    });
    expect(screen.getByLabelText("标题")).toBeEnabled();
    expect(await screen.findByRole("button", { name: "已保存" })).toBeInTheDocument();
  });

  it("写入成功但索引刷新失败时保留资产并明确提示摘要未刷新", async () => {
    const created = snapshot({
      id: "saved-review",
      kind: "content-review",
      title: "已经落库的复盘",
      sourceUrl: "https://example.com/published",
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/review-assets") && init?.method === "POST") return json(created, 201);
      if (url.includes("/api/review-assets")) return json({ items: [], generatedAt: "2026-07-13T03:00:00.000Z" });
      if (url.includes("/data/index.json")) return json({ message: "index unavailable" }, 500);
      return json(indexData);
    }));

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "新建内容复盘" }));
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "已经落库的复盘" } });
    fireEvent.change(screen.getByLabelText("已发布内容链接"), { target: { value: "https://example.com/published" } });
    fireEvent.click(screen.getByRole("button", { name: "保存内容复盘" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("已保存，摘要暂未刷新");
    expect(screen.getByRole("region", { name: "编辑内容复盘" })).toBeInTheDocument();
    expect(screen.getAllByText("待人工确认", { selector: "span" }).length).toBeGreaterThanOrEqual(1);
  });

  it("哈希冲突后载入外部最新值，旧草稿不能借新哈希再次覆盖", async () => {
    const original = snapshot({
      id: "conflicted-review",
      kind: "content-review",
      title: "发生冲突的内容复盘",
      sourceUrl: "https://example.com/published",
      findings: "最初结论",
      nextAction: "最初动作",
      hash: "a".repeat(64),
    });
    const external = {
      ...original,
      findings: "Obsidian 外部更新后的结论",
      nextAction: "外部更新后的动作",
      hash: "b".repeat(64),
      updatedAt: "2026-07-13T05:00:00.000Z",
    };
    const putBodies: Array<{ id: string; patch: Partial<ReviewAssetSnapshot>; expectedHash: string }> = [];
    let listedItems = [original];
    let listRequests = 0;

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/review-assets") && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { id: string; patch: Partial<ReviewAssetSnapshot>; expectedHash: string };
        putBodies.push(body);
        if (putBodies.length === 1) {
          return json({
            error: "hash_conflict",
            message: "复盘资产已经在 Obsidian 中被修改",
            current: external,
          }, 409);
        }
        return json({
          ...external,
          ...body.patch,
          hash: "c".repeat(64),
          updatedAt: "2026-07-13T06:00:00.000Z",
        });
      }
      if (url.includes("/api/review-assets")) {
        listRequests += 1;
        return json({ items: listedItems, generatedAt: "2026-07-13T03:00:00.000Z" });
      }
      return json(indexData);
    }));

    renderPage();
    fireEvent.click(await screen.findByText("发生冲突的内容复盘"));
    fireEvent.change(screen.getByLabelText("复盘结论"), { target: { value: "浏览器里的旧草稿" } });
    fireEvent.change(screen.getByLabelText("下一步动作"), { target: { value: "浏览器里的旧动作" } });

    listedItems = [external];
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(listRequests).toBeGreaterThan(1));
    expect(screen.getByLabelText("复盘结论")).toHaveValue("浏览器里的旧草稿");
    expect(screen.getByLabelText("下一步动作")).toHaveValue("浏览器里的旧动作");

    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("已载入最新版本，请重新编辑后保存");
    await waitFor(() => {
      expect(screen.getByLabelText("复盘结论")).toHaveValue("Obsidian 外部更新后的结论");
      expect(screen.getByLabelText("下一步动作")).toHaveValue("外部更新后的动作");
    });
    expect(putBodies).toHaveLength(1);
    expect(putBodies[0]).toMatchObject({
      expectedHash: "a".repeat(64),
      patch: { findings: "浏览器里的旧草稿", nextAction: "浏览器里的旧动作" },
    });

    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    expect(await screen.findByRole("button", { name: "已保存" })).toBeInTheDocument();
    expect(putBodies).toHaveLength(1);

    fireEvent.change(screen.getByLabelText("复盘结论"), { target: { value: "基于外部版本重新编辑的结论" } });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(putBodies).toHaveLength(2));
    expect(putBodies[1]).toMatchObject({
      expectedHash: "b".repeat(64),
      patch: { findings: "基于外部版本重新编辑的结论" },
    });
    expect(putBodies[1].patch).not.toMatchObject({ nextAction: "浏览器里的旧动作" });
  });
});
