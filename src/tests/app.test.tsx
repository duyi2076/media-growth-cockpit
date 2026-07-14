import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import { App } from "../app/App";
import {
  WorkbenchIndexProvider,
  createLocalDemoTask,
  mergeTasksWithLocalState,
  getContentOverrides,
  saveContentOverrides,
  getLocalContents,
  saveLocalContents,
  type ContentOverride,
} from "../data/adapter";
import { DetailDrawer } from "../components/ui/DetailDrawer";
import { WorkbenchGrid } from "../components/ui/WorkbenchGrid";
import { workbenchIndexFixture } from "./fixtures/workbenchIndex";
import { todayTaskSchema } from "../data/schemas";

const indexData = workbenchIndexFixture;

describe("Workbench data", () => {
  it("accepts a configured platform account list", () => {
    expect(indexData.growth.accounts.length).toBeGreaterThan(0);
    expect(new Set(indexData.growth.accounts.map((account) => account.id)).size).toBe(indexData.growth.accounts.length);
  });

  it("keeps platform totals consistent with the growth summary", () => {
    const total = indexData.growth.accounts.reduce((sum, account) => sum + account.currentFollowers, 0);
    expect(total).toBe(indexData.growth.summary.currentFollowers);
  });

  it("derives growth progress from the configured campaign baseline", () => {
    const summary = indexData.growth.summary;
    expect(summary.gainedFollowers).toBe(summary.currentFollowers - summary.baselineFollowers);
    expect(summary.growthTarget).toBeGreaterThan(0);
    expect(summary.growthGap).toBe(Math.max(0, summary.growthTarget - summary.gainedFollowers));
    expect(summary.expectedFollowers).toBe(summary.baselineFollowers + summary.growthTarget);
    expect(summary.completionRate).toBe(Math.min(1, Math.max(0, summary.gainedFollowers) / summary.growthTarget));
  });

  it("shows source-backed action targets instead of an operational summary", () => {
    expect(indexData.actionTargets.map((item) => item.label)).toEqual(["文章", "视频", "发布", "复盘", "账号拆解"]);
    expect(indexData.actionTargets.every((item) => Number.isInteger(item.current) && item.current >= 0)).toBe(true);
    const { campaignStartedAt } = indexData.growth.summary;
    expect(campaignStartedAt === null || /^\d{4}-\d{2}-\d{2}T/.test(campaignStartedAt)).toBe(true);
  });

  it("contains only valid knowledge confirmation states", () => {
    expect(indexData.knowledge.every((item) => ["已确认", "待人工确认"].includes(item.confirmation))).toBe(true);
  });

  it("allows zero to three today tasks", () => {
    expect(indexData.todayTasks.length).toBeLessThanOrEqual(3);
    expect(new Set(indexData.todayTasks.map((item) => item.id)).size).toBe(indexData.todayTasks.length);
  });

  it("accepts only paired task links from the supported asset types", () => {
    const types = ["topic", "content", "content-review", "account-breakdown", "daily-review", "task"] as const;
    for (const linkType of types) {
      expect(todayTaskSchema.safeParse({
        id: "today-one",
        title: "处理内容任务",
        done: false,
        linkId: "asset-one",
        linkType,
      }).success).toBe(true);
    }
    expect(todayTaskSchema.safeParse({
      id: "today-one",
      title: "缺少类型",
      done: false,
      linkId: "asset-one",
      linkType: null,
    }).success).toBe(false);
    expect(todayTaskSchema.safeParse({
      id: "today-one",
      title: "未知类型",
      done: false,
      linkId: "asset-one",
      linkType: "file-path",
    }).success).toBe(false);
  });

  it("keeps review count consistent with index metadata", () => {
    expect(indexData.reviewItems).toHaveLength(indexData.meta.reviewItems);
  });

  it("does not contain fictional business strings", () => {
    const raw = JSON.stringify(indexData);
    expect(raw).not.toContain("示例");
    expect(raw).not.toContain("测试数据");
    expect(raw).not.toContain("fake");
    expect(raw).not.toContain("demo@example");
  });
});

describe("App navigation", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("renders the six product-level links in sidebar", () => {
    render(
      <WorkbenchIndexProvider initialData={indexData}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </WorkbenchIndexProvider>
    );
    const nav = screen.getByRole("navigation", { name: "模块导航" });
    expect(nav).toBeInTheDocument();
    expect(nav).toHaveTextContent("增长总览");
    expect(nav).toHaveTextContent("内容工作台");
    expect(nav).toHaveTextContent("复盘与对标");
    expect(nav).toHaveTextContent("每日复盘");
    expect(nav).toHaveTextContent("AI 协作");
    expect(nav).toHaveTextContent("资产检索");
    expect(within(nav).getAllByRole("link")).toHaveLength(6);
    expect(nav).not.toHaveTextContent("任务与 Agent");
    expect(nav).not.toHaveTextContent("选题爆款 Lab");
  });

  it("renders six bottom nav items for mobile", () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === "(max-width: 1023px)" || query === "(max-width: 767px)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    render(
      <WorkbenchIndexProvider initialData={indexData}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </WorkbenchIndexProvider>
    );
    const bottomNav = screen.getByRole("navigation", { name: "底部导航" });
    expect(bottomNav).toBeInTheDocument();
    expect(within(bottomNav).getAllByRole("link")).toHaveLength(6);
    window.matchMedia = originalMatchMedia;
  });

  it("keeps global chrome focused on business information", () => {
    render(
      <WorkbenchIndexProvider initialData={indexData}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </WorkbenchIndexProvider>
    );

    const topBar = screen.getByRole("banner");
    expect(topBar).toHaveTextContent("·");
    expect(topBar).toHaveTextContent("已涨粉 / 目标");
    expect(topBar).not.toHaveTextContent("只读连接 V2");
    expect(topBar).not.toHaveTextContent("本地临时");
    expect(topBar).not.toHaveTextContent("演示模式");

    const sidebar = screen.getByRole("complementary", { name: "主导航" });
    expect(sidebar).toHaveTextContent("自媒体增长驾驶舱");
    expect(sidebar).not.toHaveTextContent("AI 博主驾驶舱");
    expect(sidebar).not.toHaveTextContent("已索引");
    expect(sidebar).not.toHaveTextContent("只读");
  });
});

describe("Growth overview density", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("renders configured compact platform metrics without explanatory account details", () => {
    render(
      <WorkbenchIndexProvider initialData={indexData}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </WorkbenchIndexProvider>
    );

    const platformBand = screen.getByRole("list", { name: "平台粉丝" });
    expect(within(platformBand).getAllByRole("listitem")).toHaveLength(indexData.growth.accounts.length);
    for (const account of indexData.growth.accounts) {
      expect(platformBand).toHaveTextContent(account.platform);
      expect(within(platformBand).getByRole("spinbutton", { name: `${account.platform}当前粉丝数` })).toHaveValue(account.currentFollowers);
    }
    expect(screen.queryByText("来源文件")).not.toBeInTheDocument();
    expect(screen.queryByText("数据状态")).not.toBeInTheDocument();
    expect(screen.queryByText(indexData.growth.accounts[0].id)).not.toBeInTheDocument();
    expect(screen.queryByText("主页入口")).not.toBeInTheDocument();
    expect(screen.queryByText(/证据：/)).not.toBeInTheDocument();
    expect(screen.queryByText("六平台账号")).not.toBeInTheDocument();
  });
});

describe("localStorage bad data fallback", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("ignores invalid task array structure and returns vault tasks", () => {
    window.localStorage.setItem("creator-v2-tasks", JSON.stringify([{ id: "bad", title: 123 }]));
    const result = mergeTasksWithLocalState(indexData.tasks);
    expect(result).toEqual(indexData.tasks);
  });

  it("ignores malformed content overrides and returns empty object", () => {
    window.localStorage.setItem("creator-v2-content-overrides", "{ invalid json");
    const result = getContentOverrides();
    expect(result).toEqual({});
  });

  it("ignores invalid local contents and returns empty array", () => {
    window.localStorage.setItem("creator-v2-local-contents", JSON.stringify([{ title: 123 }]));
    const result = getLocalContents();
    expect(result).toEqual([]);
  });
});

describe("Task simulated queue", () => {
  it("creates a local demo task with expected metadata", () => {
    const task = createLocalDemoTask({
      title: "模拟任务",
      summary: "摘要",
      status: "待办",
      type: "Agent 任务",
      priority: "P1",
      assignee: "使用者",
      assignedAgent: "creator-copywriting",
      skill: "creator-copywriting",
      inputs: [],
      outputs: [],
      verification: "人工确认",
      blockedBy: [],
      source: "本地模拟队列",
      dueAt: null,
      tags: ["本地临时"],
    });
    expect(task.sourceKind).toBe("local-demo");
    expect(task.executionMode).toBe("simulated");
    expect(task.demo).toBe(true);
    expect(task.id.startsWith("local-")).toBe(true);
  });

  it("persists local demo tasks and merges with vault tasks", () => {
    const local = createLocalDemoTask({
      title: "本地模拟",
      summary: "摘要",
      status: "待办",
      type: "Agent 任务",
      priority: "P1",
      assignee: "使用者",
      assignedAgent: null,
      skill: null,
      inputs: [],
      outputs: [],
      verification: null,
      blockedBy: [],
      source: "本地新增",
      dueAt: null,
      tags: ["本地临时"],
    });
    const merged = mergeTasksWithLocalState([...indexData.tasks, local]);
    expect(merged.filter((t) => t.sourceKind === "local-demo")).toHaveLength(1);
  });
});

describe("Content local overrides", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("saves and retrieves content overrides", () => {
    const overrides: ContentOverride = {
      "content-1": { status: "待发布", priority: "P0", nextAction: "改稿" },
    };
    saveContentOverrides(overrides);
    expect(getContentOverrides()).toEqual(overrides);
  });

  it("rejects valid JSON with invalid content enum values", () => {
    window.localStorage.setItem("creator-v2-content-overrides", JSON.stringify({
      "content-1": { status: "不存在的阶段", priority: "P9" },
    }));
    expect(getContentOverrides()).toEqual({});
    expect(window.localStorage.getItem("creator-v2-content-overrides")).toBeNull();
  });

  it("saves and retrieves local contents", () => {
    const item = {
      id: "local-content-1",
      familyId: "family-local-content-1",
      title: "本地内容测试",
      summary: "测试本地内容结构校验",
      status: "候选选题" as const,
      format: "文章" as const,
      channels: ["公众号"],
      priority: null,
      dueAt: null,
      source: "本地新增",
      nextAction: "完成选题判断",
      evidenceStatus: "待补充" as const,
      tags: ["测试"],
      updatedAt: "2026-07-11",
    };
    saveLocalContents([item]);
    expect(getLocalContents()).toHaveLength(1);
    expect(getLocalContents()[0].id).toBe("local-content-1");
  });
});

describe("Detail drawer", () => {
  it("closes on Escape key", () => {
    const onClose = vi.fn();
    render(
      <DetailDrawer title="测试抽屉" onClose={onClose}>
        <div>内容</div>
      </DetailDrawer>
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("focuses the first body field on open and does not steal focus after rerender", async () => {
    const view = render(
      <DetailDrawer title="测试抽屉" onClose={() => {}}>
        <input aria-label="标题" />
        <input aria-label="下一步" />
      </DetailDrawer>
    );
    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "标题" })).toHaveFocus();
    });

    const nextAction = screen.getByRole("textbox", { name: "下一步" });
    nextAction.focus();
    view.rerender(
      <DetailDrawer title="测试抽屉" onClose={() => {}}>
        <input aria-label="标题" />
        <input aria-label="下一步" />
      </DetailDrawer>
    );
    expect(nextAction).toHaveFocus();
  });

  it("does not close the drawer when IME composition consumes Escape", () => {
    const onClose = vi.fn();
    render(
      <DetailDrawer title="测试抽屉" onClose={onClose}>
        <input aria-label="标题" />
      </DetailDrawer>
    );
    fireEvent.keyDown(document, { key: "Escape", keyCode: 229, isComposing: true });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("WorkbenchGrid responsive structure", () => {
  it("renders main and right panel regions", () => {
    render(
      <WorkbenchIndexProvider initialData={indexData}>
        <WorkbenchGrid rightPanel={<div data-testid="right-panel">右栏</div>}>
          <div data-testid="main-panel">主内容</div>
        </WorkbenchGrid>
      </WorkbenchIndexProvider>
    );
    expect(screen.getByTestId("main-panel")).toBeInTheDocument();
    expect(screen.getByTestId("right-panel")).toBeInTheDocument();
    expect(screen.getByTestId("main-panel").closest(".workbench-grid")).toHaveAttribute("data-has-sidebar", "true");
  });

  it("uses the full workspace when no default side panel exists", () => {
    render(
      <WorkbenchIndexProvider initialData={indexData}>
        <WorkbenchGrid>
          <div data-testid="full-width-main">主内容</div>
        </WorkbenchGrid>
      </WorkbenchIndexProvider>
    );

    const main = screen.getByTestId("full-width-main");
    expect(main.closest(".workbench-grid")).toHaveAttribute("data-has-sidebar", "false");
    expect(screen.queryByRole("complementary", { name: "功能侧栏" })).not.toBeInTheDocument();
  });
});

describe("Business pages stay free of implementation sidebars", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it.each(["/content", "/knowledge", "/reviews", "/daily-reviews"])(
    "renders %s at full workspace width before a detail is selected",
    (path) => {
      window.history.pushState({}, "", path);
      const view = render(
        <WorkbenchIndexProvider initialData={indexData}>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </WorkbenchIndexProvider>
      );

      expect(screen.queryByRole("complementary", { name: "功能侧栏" })).not.toBeInTheDocument();
      expect(screen.queryByText("来源文件")).not.toBeInTheDocument();
      expect(screen.queryByText("数据状态")).not.toBeInTheDocument();
      view.unmount();
    }
  );

  it("keeps topic creation in the content toolbar and removes task modules", () => {
    window.history.pushState({}, "", "/content");
    const contentView = render(
      <WorkbenchIndexProvider initialData={indexData}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </WorkbenchIndexProvider>
    );
    expect(screen.getByRole("button", { name: "新建选题" })).toBeInTheDocument();
    contentView.unmount();

    window.history.pushState({}, "", "/tasks");
    render(
      <WorkbenchIndexProvider initialData={indexData}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </WorkbenchIndexProvider>
    );
    expect(screen.getByRole("heading", { name: "内容工作台" })).toBeInTheDocument();
    expect(screen.queryByText("任务与 Agent")).not.toBeInTheDocument();
  });
});
