import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  CockpitSettingsApiError,
  CockpitSettingsConflictError,
  getCockpitSettings,
  putCockpitSettings,
  type CockpitSettings,
  type CockpitSettingsSnapshot,
} from "@/data/cockpitSettingsClient";
import { useVaultSync } from "@/hooks/useVaultSync";

const FALLBACK_SETTINGS: CockpitSettings = {
  productName: "自媒体增长驾驶舱",
  ownerName: "使用者",
  creatorPositioning: "内容创作者",
  campaignName: "增长计划",
  growthTarget: 10_000,
  startDate: null,
  deadline: null,
  projectRelativeDir: "50-进行中项目/自媒体增长计划",
  baselineDate: "1970-01-01",
  baselineRelativePath: "60-数据与看板/01-内容数据/平台粉丝基线.md",
};

type SettingsState = "loading" | "saved" | "saving" | "error" | "conflict";

interface CockpitSettingsContextValue {
  settings: CockpitSettings;
  initialized: boolean;
  state: SettingsState;
  message: string | null;
  settingsOpen: boolean;
  openSettings: () => void;
  closeSettings: () => void;
  saveSettings: (settings: CockpitSettings) => Promise<boolean>;
  retry: () => Promise<void>;
  acceptExternal: () => void;
}

const CockpitSettingsContext = createContext<CockpitSettingsContextValue | null>(null);

export function CockpitSettingsProvider({
  children,
  onSaved,
}: {
  children: ReactNode;
  onSaved?: () => void | Promise<void>;
}) {
  const [snapshot, setSnapshot] = useState<CockpitSettingsSnapshot | null>(null);
  const [state, setState] = useState<SettingsState>("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const conflictRef = useRef<CockpitSettingsSnapshot | null>(null);
  const savingRef = useRef(false);

  const applySnapshot = useCallback((next: CockpitSettingsSnapshot) => {
    setSnapshot(next);
    conflictRef.current = null;
    setMessage(null);
    setState("saved");
  }, []);

  const load = useCallback(async () => {
    try {
      const next = await getCockpitSettings();
      if (!savingRef.current) applySnapshot(next);
    } catch (error) {
      setMessage(error instanceof CockpitSettingsApiError ? error.message : "驾驶舱设置暂时无法读取");
      setState("error");
    }
  }, [applySnapshot]);

  useEffect(() => { void load(); }, [load]);
  useVaultSync(["cockpit-settings"], load);

  const saveSettings = useCallback(async (settings: CockpitSettings) => {
    if (savingRef.current || conflictRef.current) return false;
    savingRef.current = true;
    setState("saving");
    setMessage(null);
    try {
      const next = await putCockpitSettings(settings, snapshot?.hash ?? null);
      applySnapshot(next);
      await onSaved?.();
      return true;
    } catch (error) {
      if (error instanceof CockpitSettingsConflictError) {
        conflictRef.current = error.snapshot;
        setMessage("设置已在 Obsidian 中更新，请先载入最新版本");
        setState("conflict");
      } else {
        setMessage(error instanceof CockpitSettingsApiError ? error.message : "驾驶舱设置暂时无法保存");
        setState("error");
      }
      return false;
    } finally {
      savingRef.current = false;
    }
  }, [applySnapshot, onSaved, snapshot?.hash]);

  const acceptExternal = useCallback(() => {
    if (conflictRef.current) applySnapshot(conflictRef.current);
  }, [applySnapshot]);

  const value = useMemo<CockpitSettingsContextValue>(() => ({
    settings: snapshot?.settings ?? FALLBACK_SETTINGS,
    initialized: snapshot?.initialized ?? false,
    state,
    message,
    settingsOpen,
    openSettings: () => setSettingsOpen(true),
    closeSettings: () => setSettingsOpen(false),
    saveSettings,
    retry: load,
    acceptExternal,
  }), [acceptExternal, load, message, saveSettings, settingsOpen, snapshot, state]);

  return <CockpitSettingsContext.Provider value={value}>{children}</CockpitSettingsContext.Provider>;
}

export function useCockpitSettings() {
  const value = useContext(CockpitSettingsContext);
  if (!value) throw new Error("useCockpitSettings 必须在 CockpitSettingsProvider 内使用");
  return value;
}
