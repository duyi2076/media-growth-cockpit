import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CockpitSettingsDialog } from "@/components/ui/CockpitSettingsDialog";
import { Sidebar } from "@/components/ui/Sidebar";
import { TopBar } from "@/components/ui/TopBar";
import { WorkbenchIndexProvider } from "@/data/adapter";
import type { CockpitSettings, CockpitSettingsSnapshot } from "@/data/cockpitSettingsClient";
import { CockpitSettingsProvider } from "@/hooks/useCockpitSettings";
import { workbenchIndexFixture } from "./fixtures/workbenchIndex";

const baseSettings: CockpitSettings = {
  productName: "创作者驾驶舱",
  ownerName: "小林",
  creatorPositioning: "科普博主",
  campaignName: "90 天增长计划",
  growthTarget: 20_000,
  startDate: "2026-07-15",
  deadline: "2026-10-12",
  projectRelativeDir: "50-进行中项目/科普增长计划",
  baselineDate: "2026-07-14",
  baselineRelativePath: "60-数据与看板/01-内容数据/2026-07-14-平台粉丝基线.md",
};

function snapshot(settings = baseSettings, hash: string | null = "a".repeat(64)): CockpitSettingsSnapshot {
  return { settings, initialized: hash !== null, hash, updatedAt: hash ? "2026-07-14T04:00:00.000Z" : null };
}

function json(value: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } }));
}

function renderChrome(onSaved = vi.fn()) {
  render(
    <WorkbenchIndexProvider initialData={workbenchIndexFixture}>
      <BrowserRouter>
        <CockpitSettingsProvider onSaved={onSaved}>
          <Sidebar currentPath="/" />
          <TopBar />
          <CockpitSettingsDialog />
        </CockpitSettingsProvider>
      </BrowserRouter>
    </WorkbenchIndexProvider>,
  );
}

afterEach(() => { vi.restoreAllMocks(); });

describe("驾驶舱个人化设置", () => {
  it("从本地服务读取产品名与目标显示", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => json(snapshot()));
    renderChrome();
    await waitFor(() => expect(screen.getByRole("complementary", { name: "主导航" })).toHaveTextContent("创作者驾驶舱"));
    expect(screen.getByRole("banner")).toHaveTextContent("科普博主 · 90 天增长计划");
  });

  it("网页修改后携带哈希保存，内部路径保持不变", async () => {
    const requests: RequestInit[] = [];
    const onSaved = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init = {}) => {
      if (String(input) === "/api/cockpit-settings" && init.method === "PUT") {
        requests.push(init);
        const body = JSON.parse(String(init.body));
        return json(snapshot(body.settings, "b".repeat(64)));
      }
      return json(snapshot());
    });
    renderChrome(onSaved);
    await waitFor(() => expect(screen.getByRole("button", { name: "打开驾驶舱设置" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "打开驾驶舱设置" }));
    fireEvent.change(screen.getByLabelText("创作定位"), { target: { value: "读书博主" } });
    fireEvent.change(screen.getByLabelText("目标名称"), { target: { value: "30 天输出计划" } });
    fireEvent.change(screen.getByLabelText("涨粉目标"), { target: { value: "8000" } });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await waitFor(() => expect(requests).toHaveLength(1));
    const body = JSON.parse(String(requests[0].body));
    expect(body.expectedHash).toBe("a".repeat(64));
    expect(body.settings).toMatchObject({ creatorPositioning: "读书博主", campaignName: "30 天输出计划", growthTarget: 8000 });
    expect(body.settings.projectRelativeDir).toBe(baseSettings.projectRelativeDir);
    await waitFor(() => expect(screen.getByRole("banner")).toHaveTextContent("读书博主 · 30 天输出计划"));
    expect(onSaved).toHaveBeenCalledOnce();
  });
});
