import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import { GrowthPage } from "@/app/pages/GrowthPage";
import { WorkbenchIndexProvider } from "@/data/adapter";
import type { TodayTask } from "@/types";
import { workbenchIndexFixture } from "./fixtures/workbenchIndex";

const indexData = workbenchIndexFixture;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function snapshot(tasks: TodayTask[], hash = "hash-1") {
  return {
    date: "2026-07-12",
    tasks,
    hash,
    updatedAt: "2026-07-12T03:00:00.000Z",
  };
}

function actionSnapshot() {
  return {
    targets: indexData.actionTargets.map(({ id, target }) => ({ id, target })),
    campaignStartedAt: null,
    hash: "a".repeat(64),
    updatedAt: "2026-07-12T03:00:00.000Z",
  };
}

function isActionRequest(input: RequestInfo | URL) {
  return String(input).includes("/api/action-targets");
}

function isPlatformRequest(input: RequestInfo | URL) {
  return String(input).includes("/api/platform-followers");
}

function isAiConversationsRequest(input: RequestInfo | URL) {
  return String(input).includes("/api/ai-conversations");
}

function platformSnapshot() {
  return {
    accounts: indexData.growth.accounts.map(({ id, currentFollowers, asOf }) => ({ id, currentFollowers, asOf })),
    hash: "p".repeat(64),
    updatedAt: "2026-07-12T03:00:00.000Z",
  };
}

function task(id: string, title: string, done = false): TodayTask {
  return { id, title, done, linkId: null, linkType: null };
}

function linkedConversation(taskId: string) {
  return {
    id: "conversation-linked-1",
    provider: "kimi",
    status: "open",
    templateId: "collaborate",
    context: { type: "content", id: "content-one", title: "来源内容" },
    sourceTask: {
      id: taskId,
      date: "2026-07-12",
      title: "交给 AI 的任务",
      linkType: "content",
      linkId: "content-one",
    },
    permissionMode: "readonly",
    revision: 1,
    activeTurnId: null,
    acceptedTurnId: null,
    importedTurnId: null,
    importedAt: null,
    importedRelativePath: null,
    turns: [],
    pendingPermission: null,
    createdAt: "2026-07-12T04:00:00.000Z",
    updatedAt: "2026-07-12T04:10:00.000Z",
  };
}

function renderGrowth() {
  return render(
    <WorkbenchIndexProvider initialData={indexData}>
      <BrowserRouter>
        <GrowthPage />
      </BrowserRouter>
    </WorkbenchIndexProvider>
  );
}

describe("今日三件事双向同步", () => {
  beforeEach(() => {
    window.history.pushState({}, "", "/");
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("先显示加载状态，再以 API 返回的 Obsidian 任务为权威数据", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (input: RequestInfo | URL) => {
          if (isActionRequest(input)) return Promise.resolve(jsonResponse(actionSnapshot()));
          if (isPlatformRequest(input)) return Promise.resolve(jsonResponse(platformSnapshot()));
          if (isAiConversationsRequest(input)) return Promise.resolve(jsonResponse({ conversations: [] }));
          return new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          });
        }
      )
    );

    renderGrowth();
    expect(screen.getByRole("status")).toHaveTextContent("正在读取今日任务");

    resolveFetch?.(jsonResponse(snapshot([task("api-1", "API 中的今日任务")])));
    expect(await screen.findByText("API 中的今日任务")).toBeInTheDocument();
    expect(screen.queryByText(indexData.todayTasks[0].title)).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("已保存到 Obsidian");
  });

  it("当天文件不存在时可把项目建议明确保存为今天任务", async () => {
    let savedTasks: TodayTask[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (isActionRequest(input)) return jsonResponse(actionSnapshot());
      if (isPlatformRequest(input)) return jsonResponse(platformSnapshot());
      if (isAiConversationsRequest(input)) return jsonResponse({ conversations: [] });
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { tasks: TodayTask[]; expectedHash: string | null };
        expect(body.expectedHash).toBeNull();
        savedTasks = body.tasks;
        return jsonResponse(snapshot(savedTasks, "saved-suggestions"));
      }
      return jsonResponse({
        date: "2026-07-12",
        tasks: [],
        hash: null,
        updatedAt: null,
        notFound: true,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderGrowth();
    expect(await screen.findByText(indexData.todayTasks[0].title)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("今天的任务尚未保存");
    fireEvent.click(screen.getByRole("button", { name: "保存为今天任务" }));

    await waitFor(() => expect(savedTasks).toEqual(indexData.todayTasks));
    expect(screen.getByRole("status")).toHaveTextContent("已保存到 Obsidian");
  });

  it("未落盘的建议任务会在交给 AI 前先保存，不进入无来源任务页面", async () => {
    const source = indexData.todayTasks.find((item) => item.linkType !== "task")!;
    let writeCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (isActionRequest(input)) return jsonResponse(actionSnapshot());
      if (isPlatformRequest(input)) return jsonResponse(platformSnapshot());
      if (isAiConversationsRequest(input)) return jsonResponse({ conversations: [] });
      if (init?.method === "PUT") {
        writeCount += 1;
        const body = JSON.parse(String(init.body)) as { tasks: TodayTask[] };
        return jsonResponse(snapshot(body.tasks, "saved-before-ai"));
      }
      return jsonResponse({ error: "今天还没有任务文件" }, 404);
    }));

    renderGrowth();
    fireEvent.click(await screen.findByRole("button", { name: `将“${source.title}”交给 AI` }));

    await waitFor(() => {
      expect(writeCount).toBe(1);
      expect(window.location.pathname).toBe("/ai");
      expect(new URLSearchParams(window.location.search).get("taskId")).toBe(source.id);
    });
  });

  it("建议任务保存失败时不会进入 AI 工作台", async () => {
    const source = indexData.todayTasks.find((item) => item.linkType !== "task")!;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (isActionRequest(input)) return jsonResponse(actionSnapshot());
      if (isPlatformRequest(input)) return jsonResponse(platformSnapshot());
      if (isAiConversationsRequest(input)) return jsonResponse({ conversations: [] });
      if (init?.method === "PUT") return jsonResponse({ error: "测试写入失败" }, 500);
      return jsonResponse({ error: "今天还没有任务文件" }, 404);
    }));

    renderGrowth();
    fireEvent.click(await screen.findByRole("button", { name: `将“${source.title}”交给 AI` }));

    expect(await screen.findByRole("alert")).toHaveTextContent("测试写入失败");
    expect(window.location.pathname).toBe("/");
  });

  it("支持添加、勾选、编辑、排序和删除，并且每次 PUT 都保留任务关系", async () => {
    let current = snapshot([{ ...task("task-1", "第一件事"), linkType: "topic", linkId: "fixture-content-one" }]);
    let writeCount = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (isActionRequest(_input)) return jsonResponse(actionSnapshot());
      if (isPlatformRequest(_input)) return jsonResponse(platformSnapshot());
      if (isAiConversationsRequest(_input)) return jsonResponse({ conversations: [] });
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as {
          tasks: TodayTask[];
          expectedHash: string | null;
        };
        writeCount += 1;
        current = snapshot(body.tasks, `hash-${writeCount + 1}`);
        return jsonResponse(current);
      }
      return jsonResponse(current);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderGrowth();
    await screen.findByText("第一件事");

    fireEvent.click(screen.getByRole("button", { name: "新增今日任务" }));
    fireEvent.change(screen.getByRole("textbox", { name: "新增今日任务" }), {
      target: { value: "第二件事" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存任务" }));
    expect(await screen.findByText("第二件事")).toBeInTheDocument();
    await waitFor(() => expect(writeCount).toBe(1));

    fireEvent.click(screen.getByRole("button", { name: "将“第二件事”标记为完成" }));
    await waitFor(() => {
      expect(writeCount).toBe(2);
      expect(current.tasks.find((item) => item.title === "第二件事")?.done).toBe(true);
    });

    fireEvent.click(screen.getByRole("button", { name: "编辑任务：第二件事" }));
    fireEvent.change(screen.getByRole("textbox", { name: "编辑任务：第二件事" }), {
      target: { value: "修改后的第二件事" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存任务" }));
    expect(await screen.findByText("修改后的第二件事")).toBeInTheDocument();
    await waitFor(() => expect(writeCount).toBe(3));

    fireEvent.click(screen.getAllByRole("button", { name: "上移任务" })[1]);
    await waitFor(() => {
      expect(writeCount).toBe(4);
      expect(current.tasks[0].title).toBe("修改后的第二件事");
    });

    fireEvent.click(screen.getByRole("button", { name: "删除任务：修改后的第二件事" }));
    await waitFor(() => {
      expect(writeCount).toBe(5);
      expect(current.tasks).toHaveLength(1);
    });
    expect(screen.queryByText("修改后的第二件事")).not.toBeInTheDocument();

    const lastPut = [...fetchMock.mock.calls]
      .reverse()
      .find(([, init]) => init?.method === "PUT");
    expect(lastPut?.[0]).toBe("/api/daily-tasks");
    const lastBody = JSON.parse(String(lastPut?.[1]?.body)) as { tasks: TodayTask[]; expectedHash: string };
    expect(lastBody).toMatchObject({ expectedHash: "hash-5" });
    expect(lastBody.tasks[0]).toMatchObject({ linkType: "topic", linkId: "fixture-content-one" });
  });

  it("中文输入法组词时按回车不会提前保存任务", async () => {
    let current = snapshot([]);
    let writeCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (isActionRequest(input)) return jsonResponse(actionSnapshot());
      if (isPlatformRequest(input)) return jsonResponse(platformSnapshot());
      if (isAiConversationsRequest(input)) return jsonResponse({ conversations: [] });
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { tasks: TodayTask[] };
        writeCount += 1;
        current = snapshot(body.tasks, `hash-${writeCount + 1}`);
      }
      return jsonResponse(current);
    }));

    renderGrowth();
    await screen.findByText("今天还没有任务，先添加最重要的一件事。");
    fireEvent.click(screen.getByRole("button", { name: "新增今日任务" }));
    const editor = screen.getByRole("textbox", { name: "新增今日任务" });
    fireEvent.change(editor, { target: { value: "中文选题" } });

    fireEvent.keyDown(editor, { key: "Enter", keyCode: 229, isComposing: true });
    expect(writeCount).toBe(0);
    expect(editor).toBeInTheDocument();

    fireEvent.keyDown(editor, { key: "Enter", keyCode: 13, isComposing: false });
    expect(await screen.findByText("中文选题")).toBeInTheDocument();
    await waitFor(() => expect(writeCount).toBe(1));
  });

  it("外部冲突时保留当前改动并可载入 Obsidian 版本", async () => {
    const original = snapshot([task("task-1", "本地看到的任务")]);
    const external = snapshot([task("task-2", "Obsidian 外部修改")], "external-hash");
    let dailyCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (isActionRequest(input)) return jsonResponse(actionSnapshot());
      if (isPlatformRequest(input)) return jsonResponse(platformSnapshot());
      if (isAiConversationsRequest(input)) return jsonResponse({ conversations: [] });
      dailyCalls += 1;
      return dailyCalls === 1 ? jsonResponse(original) : jsonResponse({ current: external }, 409);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderGrowth();
    await screen.findByText("本地看到的任务");
    fireEvent.click(screen.getByRole("button", { name: "将“本地看到的任务”标记为完成" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("当前改动尚未覆盖");
    expect(screen.getByText("本地看到的任务")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "载入 Obsidian 版本" }));
    expect(await screen.findByText("Obsidian 外部修改")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("已保存到 Obsidian");
  });

  it("Obsidian 删除当天文件时仍能载入空版本解除冲突", async () => {
    const original = snapshot([task("task-1", "稍后会被删除")]);
    const deleted = { date: "2026-07-12", tasks: [], hash: null, updatedAt: null };
    let dailyCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (isActionRequest(input)) return jsonResponse(actionSnapshot());
      if (isPlatformRequest(input)) return jsonResponse(platformSnapshot());
      if (isAiConversationsRequest(input)) return jsonResponse({ conversations: [] });
      dailyCalls += 1;
      return dailyCalls === 1 ? jsonResponse(original) : jsonResponse({ current: deleted }, 409);
    }));

    renderGrowth();
    await screen.findByText("稍后会被删除");
    fireEvent.click(screen.getByRole("button", { name: "将“稍后会被删除”标记为完成" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("当前改动尚未覆盖");
    fireEvent.click(screen.getByRole("button", { name: "载入 Obsidian 版本" }));
    expect(await screen.findByText("今天还没有任务，先添加最重要的一件事。")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("尚未保存");
  });

  it("编辑草稿期间收到外部更新会提示冲突而不静默覆盖", async () => {
    const original = snapshot([task("task-1", "原任务")]);
    const external = snapshot([task("task-1", "Obsidian 新标题")], "external-hash");
    let dailyCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (isActionRequest(input)) return jsonResponse(actionSnapshot());
      if (isPlatformRequest(input)) return jsonResponse(platformSnapshot());
      if (isAiConversationsRequest(input)) return jsonResponse({ conversations: [] });
      dailyCalls += 1;
      return jsonResponse(dailyCalls === 1 ? original : external);
    }));

    renderGrowth();
    await screen.findByText("原任务");
    fireEvent.click(screen.getByRole("button", { name: "编辑任务：原任务" }));
    fireEvent.change(screen.getByRole("textbox", { name: "编辑任务：原任务" }), { target: { value: "网页草稿" } });
    window.dispatchEvent(new Event("focus"));

    expect(await screen.findByRole("alert")).toHaveTextContent("Obsidian 中的任务已更新");
    expect(screen.getByDisplayValue("网页草稿")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "载入 Obsidian 版本" }));
    expect(await screen.findByText("Obsidian 新标题")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("网页草稿")).not.toBeInTheDocument();
  });

  it("保存失败时明确报错，不把改动伪装成已保存", async () => {
    const original = snapshot([task("task-1", "准备完成")]);
    let dailyCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (isActionRequest(input)) return jsonResponse(actionSnapshot());
      if (isPlatformRequest(input)) return jsonResponse(platformSnapshot());
      if (isAiConversationsRequest(input)) return jsonResponse({ conversations: [] });
      dailyCalls += 1;
      return dailyCalls === 1 ? jsonResponse(original) : jsonResponse({ error: "写入 Obsidian 失败" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderGrowth();
    await screen.findByText("准备完成");
    fireEvent.click(screen.getByRole("button", { name: "将“准备完成”标记为完成" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("写入 Obsidian 失败");
    expect(alert).not.toHaveTextContent("已保存");
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });

  it("可把一项今日任务带到 AI 工作台", async () => {
    const source = task("task-to-ai", "交给 AI 的任务");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (isActionRequest(input)) return jsonResponse(actionSnapshot());
      if (isPlatformRequest(input)) return jsonResponse(platformSnapshot());
      if (isAiConversationsRequest(input)) return jsonResponse({ conversations: [] });
      return jsonResponse(snapshot([source]));
    }));

    renderGrowth();
    fireEvent.click(await screen.findByRole("button", { name: `将“${source.title}”交给 AI` }));
    await waitFor(() => {
      expect(window.location.pathname).toBe("/ai");
      expect(new URLSearchParams(window.location.search).get("taskId")).toBe(source.id);
    });
  });

  it("刷新后识别已交付任务，并带运行记录回到 AI 工作台", async () => {
    const source = task("task-delivered", "交给 AI 的任务");
    const conversation = linkedConversation(source.id);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (isActionRequest(input)) return jsonResponse(actionSnapshot());
      if (isPlatformRequest(input)) return jsonResponse(platformSnapshot());
      if (isAiConversationsRequest(input)) return jsonResponse({ conversations: [conversation] });
      return jsonResponse(snapshot([source]));
    }));

    renderGrowth();
    const linked = await screen.findByRole("button", { name: `继续“${source.title}”的 AI 协作` });
    expect(linked).toHaveTextContent("继续协作");
    fireEvent.click(linked);
    await waitFor(() => {
      const params = new URLSearchParams(window.location.search);
      expect(params.get("taskId")).toBe(source.id);
      expect(params.get("conversationId")).toBe(conversation.id);
    });
  });

  it("同一任务标识在其他日期的交付不会污染今天的任务", async () => {
    const source = task("task-reused", "今天重新使用的任务标识");
    const conversation = linkedConversation(source.id);
    conversation.sourceTask.date = "2026-07-11";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (isActionRequest(input)) return jsonResponse(actionSnapshot());
      if (isPlatformRequest(input)) return jsonResponse(platformSnapshot());
      if (isAiConversationsRequest(input)) return jsonResponse({ conversations: [conversation] });
      return jsonResponse(snapshot([source]));
    }));

    renderGrowth();
    const delegate = await screen.findByRole("button", { name: `将“${source.title}”交给 AI` });
    expect(delegate).toHaveTextContent("交给 AI");
    expect(screen.queryByRole("button", { name: `继续“${source.title}”的 AI 协作` })).not.toBeInTheDocument();
  });

  it("已关联项目任务可在总览查看详情，并保留原关系且禁用 AI 入口", async () => {
    const source: TodayTask = {
      ...task("task-project-linked", "推进项目任务"),
      linkType: "task",
      linkId: "fixture-task-one",
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (isActionRequest(input)) return jsonResponse(actionSnapshot());
      if (isPlatformRequest(input)) return jsonResponse(platformSnapshot());
      if (isAiConversationsRequest(input)) return jsonResponse({ conversations: [] });
      return jsonResponse(snapshot([source]));
    }));

    renderGrowth();
    const blocked = await screen.findByRole("button", { name: `“${source.title}”已关联项目任务，不能交给 AI` });
    expect(blocked).toBeDisabled();
    expect(blocked).toHaveTextContent("项目任务");
    fireEvent.click(blocked);
    expect(window.location.pathname).toBe("/");

    fireEvent.click(screen.getByRole("button", { name: source.title }));
    expect(await screen.findByRole("region", { name: "确认下一篇内容的用户问题" })).toBeInTheDocument();
    expect(screen.getByLabelText("项目任务详情")).toHaveTextContent("使用者");
    expect(window.location.pathname).toBe("/");
  });

  it("三条任务已满时禁用新增并给出上限提示", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => Promise.resolve(
        isActionRequest(input)
          ? jsonResponse(actionSnapshot())
          : isPlatformRequest(input)
            ? jsonResponse(platformSnapshot())
            : isAiConversationsRequest(input)
              ? jsonResponse({ conversations: [] })
              : jsonResponse(snapshot([task("1", "一"), task("2", "二"), task("3", "三")]))
      ))
    );
    renderGrowth();

    await screen.findByText("今日任务已满（最多 3 条）");
    expect(screen.getByRole("button", { name: "新增今日任务" })).toBeDisabled();
  });
});
