import { Gear } from "phosphor-react";
import { useWorkbenchIndex } from "@/data/adapter";
import { useCockpitSettings } from "@/hooks/useCockpitSettings";

export function TopBar() {
  const { data } = useWorkbenchIndex();
  const { settings, openSettings } = useCockpitSettings();
  const summary = data?.growth.summary;

  const formattedCurrent = summary?.gainedFollowers.toLocaleString("zh-CN") ?? "—";
  const formattedTarget = summary?.growthTarget.toLocaleString("zh-CN") ?? "—";
  const formattedGap = summary?.growthGap.toLocaleString("zh-CN") ?? "—";
  const percent = summary ? (summary.completionRate * 100).toFixed(1) : "—";

  return (
    <header
      style={{
        height: "64px",
        backgroundColor: "var(--color-surface)",
        borderBottom: "1px solid var(--color-border)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 24px",
        position: "sticky",
        top: 0,
        zIndex: 50,
      }}
    >
      <div style={{ minWidth: 0, display: "flex", alignItems: "center" }}>
        <div
          style={{
            overflow: "hidden",
            fontWeight: 600,
            fontSize: "var(--text-md)",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {settings.creatorPositioning} · {settings.campaignName}
        </div>
      </div>

      <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: "12px" }}>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: "var(--text-xs)", color: "var(--color-text-tertiary)" }}>
            已涨粉 / 目标
          </div>
          <div style={{ fontWeight: 700, fontSize: "var(--text-lg)", display: "flex", alignItems: "center", gap: "6px" }}>
            <span>{formattedCurrent}</span>
            <span style={{ color: "var(--color-text-tertiary)", fontWeight: 400 }}>/</span>
            <span>{formattedTarget}</span>
            <span
              style={{
                marginLeft: "6px",
                fontSize: "var(--text-xs)",
                color: "var(--color-amber)",
                backgroundColor: "var(--color-amber-subtle)",
                padding: "2px 6px",
                borderRadius: "var(--radius-sm)",
              }}
            >
              差 {formattedGap}（{percent}%）
            </span>
          </div>
        </div>
        <button type="button" className="topbar-settings-button" aria-label="打开驾驶舱设置" title="驾驶舱设置" onClick={openSettings}>
          <Gear size={20} />
        </button>
      </div>
    </header>
  );
}
