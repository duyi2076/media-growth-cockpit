import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { X } from "phosphor-react";

interface DetailDrawerProps {
  title: string;
  children: ReactNode;
  onClose: () => void;
  returnFocus?: HTMLElement | null;
}

export function DetailDrawer({ title, children, onClose, returnFocus }: DetailDrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const returnFocusRef = useRef(returnFocus);
  onCloseRef.current = onClose;
  returnFocusRef.current = returnFocus;

  useEffect(() => {
    previousFocus.current = document.activeElement as HTMLElement;
    const timer = setTimeout(() => {
      const first = contentRef.current?.querySelector(
        "input:not([type='hidden']), select, textarea, button, [href], [tabindex]:not([tabindex='-1'])"
      ) as HTMLElement | null;
      const fallback = panelRef.current?.querySelector("button, [href], [tabindex]:not([tabindex='-1'])") as HTMLElement | null;
      (first ?? fallback)?.focus();
    }, 0);

    function onKeyDown(e: KeyboardEvent) {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
      }
      if (e.key === "Tab" && panelRef.current) {
        const focusable = Array.from(
          panelRef.current.querySelectorAll(
            "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])"
          )
        ).filter((el) => !el.hasAttribute("disabled")) as HTMLElement[];
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      clearTimeout(timer);
      const target = returnFocusRef.current ?? previousFocus.current;
      window.setTimeout(() => {
        if (target && target instanceof HTMLElement && target.isConnected) {
          target.focus();
          return;
        }
        const fallback = document.querySelector("main button, main [href], main [tabindex='0']") as HTMLElement | null;
        fallback?.focus();
      }, 0);
    };
  }, []);

  return (
    <div
      ref={panelRef}
      role="region"
      aria-label={title}
      tabIndex={-1}
      style={{
        display: "flex",
        flexDirection: "column",
        backgroundColor: "var(--color-surface)",
        borderLeft: "1px solid var(--color-border)",
        height: "100%",
        outline: "none",
      }}
    >
      <div
        style={{
          height: "56px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 16px",
          borderBottom: "1px solid var(--color-border-subtle)",
          flexShrink: 0,
        }}
      >
        <h2 style={{ fontSize: "var(--text-md)", fontWeight: 600 }}>{title}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭详情"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: "32px",
            height: "32px",
            border: "none",
            borderRadius: "var(--radius-md)",
            backgroundColor: "transparent",
            color: "var(--color-text-secondary)",
          }}
        >
          <X size={18} />
        </button>
      </div>
      <div ref={contentRef} style={{ flex: 1, overflow: "auto", padding: "16px" }}>{children}</div>
    </div>
  );
}
