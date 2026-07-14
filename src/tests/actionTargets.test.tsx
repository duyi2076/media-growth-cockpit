import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import { GrowthPage } from "@/app/pages/GrowthPage";
import { WorkbenchIndexProvider } from "@/data/adapter";
import { workbenchIndexFixture } from "./fixtures/workbenchIndex";

const indexData = workbenchIndexFixture;

function platformSnapshot() {
  return {
    accounts: indexData.growth.accounts.map(({ id, currentFollowers, asOf }) => ({ id, currentFollowers, asOf })),
    hash: "p".repeat(64),
    updatedAt: "2026-07-12T04:00:00.000Z",
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("行动目标编辑", () => {
  it("配置的平台当前粉丝可编辑并写回受控接口", async () => {
    const account = indexData.growth.accounts[0];
    const nextFollowers = account.currentFollowers + 2;
    let savedBody: Record<string, unknown> | null = null;
    let followers = platformSnapshot();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/platform-followers")) {
        if (init?.method === "PUT") {
          savedBody = JSON.parse(String(init.body));
          const next = (savedBody as { accounts: Array<{ id: string; currentFollowers: number }> }).accounts;
          followers = {
            accounts: next.map((account) => ({ ...account, asOf: "2026-07-12" })),
            hash: "q".repeat(64),
            updatedAt: "2026-07-12T04:01:00.000Z",
          };
        }
        return json(followers);
      }
      if (url.includes("/api/action-targets")) return json({ targets: indexData.actionTargets.map(({ id, target }) => ({ id, target })), campaignStartedAt: "2026-07-12T04:00:00.000Z", hash: "a".repeat(64), updatedAt: "2026-07-12T04:00:00.000Z" });
      if (url.includes("/data/index.json")) return json(indexData);
      return json({ date: "2026-07-12", tasks: indexData.todayTasks, hash: "c".repeat(64), updatedAt: "2026-07-12T04:00:00.000Z" });
    }));

    render(
      <WorkbenchIndexProvider initialData={indexData}>
        <BrowserRouter><GrowthPage /></BrowserRouter>
      </WorkbenchIndexProvider>,
    );

    const input = await screen.findByRole("spinbutton", { name: `${account.platform}当前粉丝数` });
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.change(input, { target: { value: String(nextFollowers) } });
    fireEvent.blur(input);
    await waitFor(() => expect(savedBody).not.toBeNull());
    expect((savedBody as unknown as { accounts: Array<{ id: string; currentFollowers: number }> }).accounts.find((item) => item.id === account.id)?.currentFollowers).toBe(nextFollowers);
  });

  it("目标数字可在网页填写并 PUT 到受控接口", async () => {
    let savedBody: Record<string, unknown> | null = null;
    let actionSnapshot = {
      targets: indexData.actionTargets.map(({ id, target }) => ({ id, target })),
      campaignStartedAt: null as string | null,
      hash: "a".repeat(64),
      updatedAt: "2026-07-12T04:00:00.000Z",
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/action-targets")) {
        if (init?.method === "PUT") {
          savedBody = JSON.parse(String(init.body));
          actionSnapshot = {
            targets: (savedBody as { targets: typeof actionSnapshot.targets }).targets,
            campaignStartedAt: (savedBody as { startCampaign?: boolean }).startCampaign ? "2026-07-12T04:01:00.000Z" : actionSnapshot.campaignStartedAt,
            hash: "b".repeat(64),
            updatedAt: "2026-07-12T04:01:00.000Z",
          };
        }
        return json(actionSnapshot);
      }
      if (String(input).includes("/api/platform-followers")) return json(platformSnapshot());
      return json({
        date: "2026-07-12",
        tasks: indexData.todayTasks,
        hash: "c".repeat(64),
        updatedAt: "2026-07-12T04:00:00.000Z",
      });
    }));

    render(
      <WorkbenchIndexProvider initialData={indexData}>
        <BrowserRouter><GrowthPage /></BrowserRouter>
      </WorkbenchIndexProvider>
    );

    for (const label of ["文章", "视频", "发布", "复盘", "账号拆解"]) {
      expect(await screen.findByRole("spinbutton", { name: `${label}目标数量` })).toBeEnabled();
    }

    const publishTarget = screen.getByRole("spinbutton", { name: "发布目标数量" });
    fireEvent.change(publishTarget, { target: { value: "180" } });
    fireEvent.blur(publishTarget);

    await waitFor(() => expect(screen.getByRole("spinbutton", { name: "发布目标数量" })).toHaveValue(180));
    await waitFor(() => expect(savedBody).not.toBeNull());
    if (!savedBody) throw new Error("目标 PUT 未发生");
    const persisted = savedBody as unknown as {
      expectedHash: string;
      targets: Array<{ id: string; target: number | null }>;
    };
    expect(persisted.expectedHash).toBe("a".repeat(64));
    const savedTargets = persisted.targets;
    expect(savedTargets.find((item) => item.id === "platform-publish")?.target).toBe(180);
    expect(screen.queryByText("内容与任务摘要")).not.toBeInTheDocument();
  });

  it("正式开始前完成数为零，并要求二次确认后才写入开始时间", async () => {
    let requestBody: Record<string, unknown> | null = null;
    let snapshot = {
      targets: indexData.actionTargets.map(({ id, target }) => ({ id, target })),
      campaignStartedAt: null as string | null,
      hash: "a".repeat(64),
      updatedAt: "2026-07-12T04:00:00.000Z",
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/action-targets")) {
        if (init?.method === "PUT") {
          requestBody = JSON.parse(String(init.body));
          snapshot = {
            ...snapshot,
            campaignStartedAt: "2026-07-12T04:01:00.000Z",
            hash: "b".repeat(64),
            updatedAt: "2026-07-12T04:01:00.000Z",
          };
        }
        return json(snapshot);
      }
      if (String(input).includes("/api/platform-followers")) return json(platformSnapshot());
      return json({ date: "2026-07-12", tasks: indexData.todayTasks, hash: "c".repeat(64), updatedAt: "2026-07-12T04:00:00.000Z" });
    }));

    render(
      <WorkbenchIndexProvider initialData={indexData}>
        <BrowserRouter><GrowthPage /></BrowserRouter>
      </WorkbenchIndexProvider>,
    );

    for (const item of indexData.actionTargets) expect(item.current).toBe(0);
    fireEvent.click(await screen.findByRole("button", { name: "正式开始统计" }));
    expect(screen.getByRole("group", { name: "确认正式开始统计" })).toBeInTheDocument();
    expect(requestBody).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "确认开始" }));
    await screen.findByText("统计自 2026-07-12");
    expect(requestBody).toMatchObject({ startCampaign: true });
  });
});
