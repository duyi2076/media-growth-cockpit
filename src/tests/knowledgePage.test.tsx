import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import { KnowledgePage } from "@/app/pages/KnowledgePage";
import { WorkbenchIndexProvider } from "@/data/adapter";
import type { WorkbenchIndex } from "@/types";
import { workbenchIndexFixture } from "./fixtures/workbenchIndex";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function knowledgeIndex(): WorkbenchIndex {
  return {
    ...workbenchIndexFixture,
    knowledge: [
      ...workbenchIndexFixture.knowledge,
      {
        id: "pending-knowledge",
        title: "等待确认的方法",
        summary: "尚未经过人工确认。",
        type: "方法",
        confirmation: "待人工确认",
        sensitivity: "内部",
        source: "asset-ref-pending-knowledge",
        topics: ["待确认主题"],
        updatedAt: "2026-07-15",
      },
      {
        id: "sensitive-knowledge",
        title: "客户私密访谈",
        summary: "任何筛选条件下都不能显示。",
        type: "原始材料",
        confirmation: "已确认",
        sensitivity: "敏感",
        source: "asset-ref-sensitive-knowledge",
        topics: ["隐私"],
        updatedAt: "2026-07-16",
      },
    ],
  };
}

function renderPage(data = knowledgeIndex()) {
  return render(
    <WorkbenchIndexProvider initialData={data}>
      <BrowserRouter><KnowledgePage /></BrowserRouter>
    </WorkbenchIndexProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("资产检索", () => {
  it("搜索与类型筛选命中正确资产，待确认需主动开启，敏感资产始终排除", async () => {
    renderPage();

    expect(screen.getByText("教程内容先说明使用场景")).toBeInTheDocument();
    expect(screen.queryByText("等待确认的方法")).not.toBeInTheDocument();
    expect(screen.queryByText("客户私密访谈")).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "搜索资产" }), { target: { value: "复杂工具" } });
    expect(screen.getByText("把复杂工具讲清楚的三个步骤")).toBeInTheDocument();
    expect(screen.queryByText("教程内容先说明使用场景")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    fireEvent.change(screen.getByRole("combobox", { name: "资产类型" }), { target: { value: "项目" } });
    expect(screen.getByText("季度增长计划")).toBeInTheDocument();
    expect(screen.queryByText("教程内容先说明使用场景")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "含待确认" }));
    expect(screen.getByText("等待确认的方法")).toBeInTheDocument();
    expect(screen.queryByText("客户私密访谈")).not.toBeInTheDocument();
  });

  it("详情通过受控接口打开 Obsidian，并在失败后允许同按钮重试", async () => {
    const requests: string[] = [];
    let opens = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/open-obsidian")) {
        opens += 1;
        requests.push((JSON.parse(String(init?.body)) as { source: string }).source);
        return opens === 1
          ? json({ opened: false, message: "Obsidian 暂时无法打开" }, 500)
          : json({ opened: true });
      }
      return json(knowledgeIndex());
    }));

    renderPage();
    fireEvent.click(screen.getByText("教程内容先说明使用场景"));
    expect(screen.getByRole("region", { name: "教程内容先说明使用场景" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "打开原文" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Obsidian 暂时无法打开");
    fireEvent.click(screen.getByRole("button", { name: "打开失败，重试" }));
    await waitFor(() => expect(opens).toBe(2));
    expect(requests).toEqual(["asset-ref-knowledge-one", "asset-ref-knowledge-one"]);
    expect(screen.getByRole("button", { name: "打开原文" })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
