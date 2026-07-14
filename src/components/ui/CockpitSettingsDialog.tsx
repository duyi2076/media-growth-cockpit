import { useEffect, useRef, useState, type FormEvent } from "react";
import { X } from "phosphor-react";
import { useCockpitSettings } from "@/hooks/useCockpitSettings";
import type { CockpitSettings } from "@/data/cockpitSettingsClient";

export function CockpitSettingsDialog() {
  const {
    settings,
    initialized,
    state,
    message,
    settingsOpen,
    closeSettings,
    saveSettings,
    retry,
    acceptExternal,
  } = useCockpitSettings();
  const [draft, setDraft] = useState<CockpitSettings>(settings);
  const composing = useRef(false);

  useEffect(() => { if (settingsOpen) setDraft(settings); }, [settings, settingsOpen]);
  useEffect(() => {
    if (!settingsOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (composing.current || event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") closeSettings();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeSettings, settingsOpen]);

  if (!settingsOpen) return null;
  const disabled = state === "saving" || state === "loading" || state === "conflict";
  const set = <K extends keyof CockpitSettings>(key: K, value: CockpitSettings[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };
  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (composing.current) return;
    if (await saveSettings(draft)) closeSettings();
  };

  return (
    <div className="settings-dialog-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) closeSettings(); }}>
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="cockpit-settings-title">
        <div className="settings-dialog-header">
          <div>
            <h2 id="cockpit-settings-title">驾驶舱设置</h2>
            <p>{initialized ? "修改后保存到 Obsidian。" : "首次保存后将在 Obsidian 创建设置文件。"}</p>
          </div>
          <button type="button" className="icon-button" aria-label="关闭驾驶舱设置" onClick={closeSettings}><X size={20} /></button>
        </div>
        <form
          className="settings-form"
          onSubmit={handleSubmit}
          onCompositionStartCapture={() => { composing.current = true; }}
          onCompositionEndCapture={() => { composing.current = false; }}
          onKeyDownCapture={(event) => {
            if (event.key === "Enter" && (composing.current || event.nativeEvent.isComposing || event.keyCode === 229)) {
              event.preventDefault();
            }
          }}
        >
          <label>
            <span>产品名称</span>
            <input value={draft.productName} maxLength={40} required onChange={(event) => set("productName", event.target.value)} />
          </label>
          <label>
            <span>使用者名称</span>
            <input value={draft.ownerName} maxLength={40} required onChange={(event) => set("ownerName", event.target.value)} />
          </label>
          <div className="settings-form-row">
            <label>
              <span>创作定位</span>
              <input value={draft.creatorPositioning} maxLength={60} required onChange={(event) => set("creatorPositioning", event.target.value)} />
            </label>
            <label>
              <span>目标名称</span>
              <input value={draft.campaignName} maxLength={80} required onChange={(event) => set("campaignName", event.target.value)} />
            </label>
          </div>
          <div className="settings-form-row settings-form-row-three">
            <label>
              <span>涨粉目标</span>
              <input type="number" min={1} max={100_000_000} value={draft.growthTarget} required onChange={(event) => set("growthTarget", Number(event.target.value))} />
            </label>
            <label>
              <span>开始日期</span>
              <input type="date" value={draft.startDate ?? ""} onChange={(event) => set("startDate", event.target.value || null)} />
            </label>
            <label>
              <span>截止日期</span>
              <input type="date" min={draft.startDate ?? undefined} value={draft.deadline ?? ""} onChange={(event) => set("deadline", event.target.value || null)} />
            </label>
          </div>
          <p className="settings-storage-note">显示名称的修改不会重命名已有项目目录。</p>
          {message ? (
            <div className="settings-message" role="alert">
              <span>{message}</span>
              {state === "conflict" ? <button type="button" onClick={acceptExternal}>载入最新版本</button> : null}
              {state === "error" ? <button type="button" onClick={() => void retry()}>重试</button> : null}
            </div>
          ) : null}
          <div className="settings-dialog-actions">
            <button type="button" onClick={closeSettings} disabled={state === "saving"}>取消</button>
            <button type="submit" className="primary-button" disabled={disabled}>{state === "saving" ? "保存中…" : "保存设置"}</button>
          </div>
        </form>
      </section>
    </div>
  );
}
