import type { ReactNode } from "react";
import { useMediaQuery } from "@/hooks/useMediaQuery";

interface WorkbenchGridProps {
  children: ReactNode;
  rightPanel?: ReactNode;
  detail?: ReactNode;
  onCloseDetail?: () => void;
  className?: string;
  columns?: 2 | 3;
}

export function WorkbenchGrid({ children, rightPanel, detail, onCloseDetail, className, columns = 2 }: WorkbenchGridProps) {
  const isNarrow = useMediaQuery("(max-width: 1023px)");
  const hasDetail = detail != null;
  const hasSidebar = hasDetail || rightPanel != null;

  return (
    <>
      <div
        className={`workbench-grid ${className ?? ""}`}
        data-columns={columns}
        data-has-detail={hasDetail}
        data-has-sidebar={hasSidebar}
        style={{
          display: "grid",
          gap: "var(--workspace-gap)",
          padding: "var(--workspace-padding)",
          alignItems: "start",
        }}
      >
        <div className="workbench-main" style={{ minWidth: 0 }}>{children}</div>
        {!isNarrow && hasSidebar && (
          <aside
            className="workbench-right"
            aria-label="功能侧栏"
            style={{
              flexDirection: "column",
              gap: "var(--workspace-gap)",
              position: "sticky",
              top: "calc(var(--topbar-height) + 16px)",
              maxHeight: "calc(100vh - var(--topbar-height) - 32px)",
              overflow: "auto",
            }}
          >
            {hasDetail ? detail : rightPanel}
          </aside>
        )}
      </div>
      {hasDetail && isNarrow && onCloseDetail && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="详情"
          style={{
            position: "fixed",
            inset: 0,
            top: "var(--topbar-height)",
            backgroundColor: "rgba(31, 36, 33, 0.24)",
            zIndex: 150,
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              onCloseDetail();
            }
          }}
        >
          <div
            style={{
              position: "absolute",
              right: 0,
              top: 0,
              bottom: 0,
              width: "min(420px, 100%)",
              boxShadow: "var(--shadow-md)",
            }}
          >
            {detail}
          </div>
        </div>
      )}
    </>
  );
}

interface RightPanelProps {
  action?: ReactNode;
  className?: string;
}

export function RightPanel({ action, className }: RightPanelProps) {
  return (
    <div
      className={`right-panel ${className ?? ""}`}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--workspace-gap)",
      }}
    >
      {action != null && <section aria-label="行动">{action}</section>}
    </div>
  );
}
