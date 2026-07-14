import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { z } from "zod";
import type { TaskItem, WorkbenchIndex } from "@/types";
import { timeoutSignal } from "@/data/timeoutSignal";
import {
  taskItemSchema,
  contentItemSchema,
  contentStatusSchema,
  prioritySchema,
  workbenchIndexSchema,
} from "@/data/schemas";
import { useVaultSync } from "@/hooks/useVaultSync";

interface IndexState {
  data: WorkbenchIndex | null;
  loading: boolean;
  error: string | null;
  syncError: string | null;
  refresh: () => Promise<void>;
}

const WorkbenchIndexContext = createContext<IndexState>({
  data: null,
  loading: true,
  error: null,
  syncError: null,
  refresh: async () => {},
});

export function WorkbenchIndexProvider({
  children,
  initialData,
}: {
  children: ReactNode;
  initialData?: WorkbenchIndex;
}) {
  const [state, setState] = useState<IndexState>(() => ({
    data: initialData ?? null,
    loading: initialData ? false : true,
    error: null,
    syncError: null,
    refresh: async () => {},
  }));

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/data/index.json?t=${Date.now()}`, {
        cache: "no-store",
        signal: timeoutSignal(8_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.json();
      const parsed = workbenchIndexSchema.safeParse(raw);
      if (!parsed.success) throw new Error("索引结构校验失败");
      setState((current) => ({
        ...current,
        data: parsed.data as WorkbenchIndex,
        loading: false,
        error: null,
        syncError: null,
        refresh,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "加载失败";
      setState((current) => ({
        ...current,
        loading: false,
        error: current.data ? null : message,
        syncError: current.data ? message : null,
        refresh,
      }));
      throw error;
    }
  }, []);

  useEffect(() => {
    if (initialData) {
      setState((current) => ({ ...current, refresh }));
      return;
    }
    let cancelled = false;
    const load = () => {
      refresh().catch((err) => {
        if (!cancelled) {
          setState((current) => ({ ...current, loading: false, error: current.data ? null : err.message || "加载失败", refresh }));
        }
      });
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [initialData, refresh]);

  useVaultSync(["index"], refresh);

  return (
    <WorkbenchIndexContext.Provider value={state}>
      {children}
    </WorkbenchIndexContext.Provider>
  );
}

export function useWorkbenchIndex() {
  return useContext(WorkbenchIndexContext);
}

const localTasksSchema = z.array(taskItemSchema);
export const LOCAL_STATE_EVENT = "creator-local-state-change";

function notifyLocalStateChange() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(LOCAL_STATE_EVENT));
  }
}

function safeLocalGet<T>(key: string, schema: z.ZodType<T>): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const result = schema.safeParse(parsed);
    if (!result.success) {
      // 坏结构：静默清空，避免崩溃
      try {
        localStorage.removeItem(key);
        notifyLocalStateChange();
      } catch {}
      return null;
    }
    return result.data;
  } catch {
    return null;
  }
}

function safeLocalSet(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    notifyLocalStateChange();
  } catch (e) {
    const err = e as DOMException;
    if (err?.name === "QuotaExceededError" || err?.name === "SecurityError") {
      // 静默忽略存储配额或安全异常
    }
  }
}

export function createLocalDemoTask(
  draft: Omit<TaskItem, "id" | "updatedAt" | "demo" | "sourceKind" | "executionMode">
): TaskItem {
  const now = new Date().toISOString().slice(0, 10);
  return {
    ...draft,
    id: `local-${Date.now()}`,
    updatedAt: now,
    demo: true,
    sourceKind: "local-demo",
    executionMode: "simulated",
  };
}

const LEGACY_TODAY_TASKS_KEY = "creator-v2-today-tasks";
const TASKS_KEY = "creator-v2-tasks";
const CONTENT_OVERRIDES_KEY = "creator-v2-content-overrides";
const LOCAL_CONTENTS_KEY = "creator-v2-local-contents";

export function mergeTasksWithLocalState(vaultTasks: TaskItem[]): TaskItem[] {
  const saved = safeLocalGet(TASKS_KEY, localTasksSchema);
  if (!saved) return vaultTasks;
  const vaultIds = new Set(vaultTasks.map((t) => t.id));
  const locals = saved.filter((t) => t.sourceKind === "local-demo" && !vaultIds.has(t.id));
  return [...vaultTasks, ...locals];
}

export function saveTasksLocalState(tasks: TaskItem[]) {
  const locals = tasks.filter((t) => t.sourceKind === "local-demo");
  safeLocalSet(TASKS_KEY, locals);
}

const contentOverrideSchema = z.record(
  z.string(),
  z.object({
    status: contentStatusSchema.optional(),
    priority: prioritySchema.nullable().optional(),
    nextAction: z.string().optional(),
  })
);

export type ContentOverride = z.infer<typeof contentOverrideSchema>;

export function getContentOverrides(): ContentOverride {
  return safeLocalGet(CONTENT_OVERRIDES_KEY, contentOverrideSchema) ?? {};
}

export function saveContentOverrides(overrides: ContentOverride) {
  safeLocalSet(CONTENT_OVERRIDES_KEY, overrides);
}

// 本地新增内容 schema：与 Vault 内容字段一致，渲染时根据 source 判断本地临时
const localContentSchema = contentItemSchema;

const localContentsSchema = z.array(localContentSchema);

export type LocalContentItem = z.infer<typeof localContentSchema>;

export function getLocalContents(): LocalContentItem[] {
  return safeLocalGet(LOCAL_CONTENTS_KEY, localContentsSchema) ?? [];
}

export function saveLocalContents(items: LocalContentItem[]) {
  safeLocalSet(LOCAL_CONTENTS_KEY, items);
}

export function getLocalTempCount(): number {
  let count = 0;
  const tasks = safeLocalGet(TASKS_KEY, localTasksSchema);
  if (tasks) count += tasks.length;
  const overrides = safeLocalGet(CONTENT_OVERRIDES_KEY, contentOverrideSchema);
  if (overrides) count += Object.keys(overrides).length;
  const localContents = safeLocalGet(LOCAL_CONTENTS_KEY, localContentsSchema);
  if (localContents) count += localContents.length;
  return count;
}

export function useLocalTempCount(): number {
  const [count, setCount] = useState(() => getLocalTempCount());

  useEffect(() => {
    const refresh = () => setCount(getLocalTempCount());
    window.addEventListener(LOCAL_STATE_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(LOCAL_STATE_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  return count;
}

export function clearAllLocalState() {
  try {
    localStorage.removeItem(LEGACY_TODAY_TASKS_KEY);
    localStorage.removeItem(TASKS_KEY);
    localStorage.removeItem(CONTENT_OVERRIDES_KEY);
    localStorage.removeItem(LOCAL_CONTENTS_KEY);
    notifyLocalStateChange();
  } catch {}
}
