import type { ReactNode } from "react";

interface ModuleHeaderProps {
  title: string;
  goal: string;
  children?: ReactNode;
}

export function ModuleHeader({ title, goal, children }: ModuleHeaderProps) {
  return (
    <div
      style={{
        padding: "20px 24px 0",
        display: "flex",
        flexDirection: "column",
        gap: "12px",
      }}
    >
      <div>
        <h1 style={{ fontSize: "var(--text-xl)", fontWeight: 700 }}>{title}</h1>
        <p style={{ marginTop: "4px", color: "var(--color-text-secondary)", fontSize: "var(--text-sm)" }}>{goal}</p>
      </div>
      {children}
    </div>
  );
}
