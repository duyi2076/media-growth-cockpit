import { NavLink } from "react-router-dom";
import {
  TrendUp,
  SquaresFour,
  ChartBar,
  NotePencil,
  MagnifyingGlass,
  ChatCircleDots,
} from "phosphor-react";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useCockpitSettings } from "@/hooks/useCockpitSettings";

const navItems = [
  { path: "/", label: "增长总览", icon: TrendUp, testId: "nav-growth" },
  { path: "/content", label: "内容工作台", icon: SquaresFour, testId: "nav-content" },
  { path: "/reviews", label: "复盘与对标", icon: ChartBar, testId: "nav-reviews" },
  { path: "/daily-reviews", label: "每日复盘", icon: NotePencil, testId: "nav-daily-reviews" },
  { path: "/ai", label: "AI 协作", icon: ChatCircleDots, testId: "nav-ai" },
  { path: "/knowledge", label: "资产检索", icon: MagnifyingGlass, testId: "nav-knowledge" },
];

export function Sidebar({ currentPath }: { currentPath: string }) {
  const isMobile = useMediaQuery("(max-width: 767px)");
  const { settings } = useCockpitSettings();

  if (isMobile) return null;

  return (
    <aside
      role="complementary"
      aria-label="主导航"
      style={{
        height: "100%",
        backgroundColor: "var(--color-surface)",
        borderRight: "1px solid var(--color-border)",
        display: "flex",
        flexDirection: "column",
        position: "sticky",
        left: 0,
        top: 0,
        zIndex: 100,
      }}
    >
      <div
        className="sidebar-logo"
        style={{
          height: "64px",
          alignItems: "center",
          padding: "0 20px",
          borderBottom: "1px solid var(--color-border-subtle)",
          fontWeight: 600,
          fontSize: "var(--text-md)",
        }}
      >
        {settings.productName}
      </div>
      <nav style={{ flex: 1, padding: "12px 10px" }} aria-label="模块导航">
        <ul style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = item.path === "/" ? currentPath === "/" : currentPath.startsWith(item.path);
            return (
              <li key={item.path}>
                <NavLink
                  to={item.path}
                  data-testid={item.testId}
                  aria-label={item.label}
                  title={item.label}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "var(--sidebar-justify, flex-start)",
                    gap: "10px",
                    padding: "10px 12px",
                    borderRadius: "var(--radius-md)",
                    color: active ? "var(--color-text-inverse)" : "var(--color-text-secondary)",
                    backgroundColor: active ? "var(--color-primary)" : "transparent",
                    textDecoration: "none",
                    fontSize: "var(--text-base)",
                    transition: "background-color 0.15s, color 0.15s",
                  }}
                >
                  <Icon size={20} weight={active ? "fill" : "regular"} />
                  <span className="sidebar-label">{item.label}</span>
                </NavLink>
              </li>
            );
          })}
        </ul>
      </nav>
    </aside>
  );
}

export function BottomNav({ currentPath }: { currentPath: string }) {
  const isMobile = useMediaQuery("(max-width: 767px)");
  return (
    <nav
      className="bottom-nav"
      aria-label="底部导航"
      style={{
        display: isMobile ? "flex" : "none",
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        height: "56px",
        backgroundColor: "var(--color-surface)",
        borderTop: "1px solid var(--color-border)",
        zIndex: 100,
        justifyContent: "space-around",
        alignItems: "center",
        padding: "0 8px",
      }}
    >
      {navItems.map((item) => {
        const Icon = item.icon;
        const active = item.path === "/" ? currentPath === "/" : currentPath.startsWith(item.path);
        return (
          <NavLink
            key={item.path}
            to={item.path}
            data-testid={item.testId}
            aria-label={item.label}
            title={item.label}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "2px",
              padding: "6px 8px",
              borderRadius: "var(--radius-md)",
              color: active ? "var(--color-primary)" : "var(--color-text-secondary)",
              textDecoration: "none",
              fontSize: "var(--text-xs)",
            }}
          >
            <Icon size={20} weight={active ? "fill" : "regular"} />
            <span>{item.label.slice(0, 4)}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}
