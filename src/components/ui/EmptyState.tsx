import { MagnifyingGlass, Warning } from "phosphor-react";
import type { ReactNode } from "react";

interface EmptyStateProps {
  title?: string;
  description?: string;
  icon?: "search" | "warning";
  children?: ReactNode;
}

export function EmptyState({
  title = "暂无数据",
  description = "当前条件下没有找到匹配项。",
  icon = "search",
  children,
}: EmptyStateProps) {
  const Icon = icon === "warning" ? Warning : MagnifyingGlass;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "48px 24px",
        color: "var(--color-text-tertiary)",
        textAlign: "center",
      }}
    >
      <Icon size={32} />
      <div style={{ marginTop: "12px", fontWeight: 600, color: "var(--color-text-secondary)" }}>{title}</div>
      <div style={{ marginTop: "4px", fontSize: "var(--text-sm)" }}>{description}</div>
      {children && <div style={{ marginTop: "16px" }}>{children}</div>}
    </div>
  );
}
