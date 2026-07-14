import { useEffect, useState } from "react";
import { ArrowSquareOut } from "phosphor-react";
import { OpenObsidianApiError, openInObsidian } from "@/data/openObsidianClient";

export function OpenInObsidianButton({ source, primary = false }: { source: string; primary?: boolean }) {
  const [state, setState] = useState<"idle" | "opening" | "error">("idle");
  const [message, setMessage] = useState("");

  useEffect(() => {
    setState("idle");
    setMessage("");
  }, [source]);

  const open = async () => {
    if (state === "opening") return;
    setState("opening");
    setMessage("");
    try {
      await openInObsidian(source);
      setState("idle");
    } catch (error) {
      setState("error");
      setMessage(error instanceof OpenObsidianApiError ? error.message : "未能打开 Obsidian，请重试");
    }
  };

  return (
    <div className="open-obsidian-control">
      <button
        type="button"
        className={`open-source-link${primary ? " is-primary" : ""}${state === "error" ? " is-error" : ""}`}
        onClick={() => void open()}
        disabled={state === "opening"}
      >
        {state === "opening" ? "正在打开…" : state === "error" ? "打开失败，重试" : "打开原文"}
        <ArrowSquareOut size={15} aria-hidden="true" />
      </button>
      {state === "error" ? <span className="open-source-error" role="alert">{message}</span> : null}
    </div>
  );
}
