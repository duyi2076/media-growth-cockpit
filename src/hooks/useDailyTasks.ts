import { useCallback, useEffect, useRef, useState } from "react";
import {
  DailyTasksApiError,
  DailyTasksConflictError,
  DailyTasksNotFoundError,
  getDailyTasks,
  putDailyTasks,
  type DailyTasksSnapshot,
} from "@/data/dailyTasksClient";
import type { TodayTask } from "@/types";
import { useVaultSync } from "@/hooks/useVaultSync";

export type DailyTasksSyncState =
  | "loading"
  | "unsaved"
  | "saving"
  | "saved"
  | "error"
  | "conflict";

export function getShanghaiDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function errorMessage(error: unknown): string {
  return error instanceof DailyTasksApiError ? error.message : "今日任务暂时无法保存";
}

export function useDailyTasks(fallbackTasks: TodayTask[], hasLocalDraft = false) {
  const fallbackRef = useRef(fallbackTasks.slice(0, 3));
  const [date, setDate] = useState(getShanghaiDate);
  const [tasks, setTasks] = useState<TodayTask[]>(fallbackRef.current);
  const [syncState, setSyncState] = useState<DailyTasksSyncState>("loading");
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [apiAvailable, setApiAvailable] = useState(false);
  const [conflictSnapshot, setConflictSnapshot] = useState<DailyTasksSnapshot | null>(null);

  const tasksRef = useRef(tasks);
  const hashRef = useRef<string | null>(null);
  const syncStateRef = useRef<DailyTasksSyncState>("loading");
  const dirtyRef = useRef(false);
  const localDraftRef = useRef(hasLocalDraft);
  const mountedRef = useRef(true);

  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  useEffect(() => {
    localDraftRef.current = hasLocalDraft;
  }, [hasLocalDraft]);

  const updateSyncState = useCallback((next: DailyTasksSyncState) => {
    syncStateRef.current = next;
    setSyncState(next);
  }, []);

  const applySnapshot = useCallback(
    (snapshot: DailyTasksSnapshot) => {
      hashRef.current = snapshot.hash;
      tasksRef.current = snapshot.tasks;
      dirtyRef.current = false;
      setDate(snapshot.date);
      setTasks(snapshot.tasks);
      setUpdatedAt(snapshot.updatedAt);
      setMessage(null);
      setConflictSnapshot(null);
      setApiAvailable(true);
      updateSyncState(snapshot.hash === null ? "unsaved" : "saved");
    },
    [updateSyncState]
  );

  const load = useCallback(
    async (initial = false) => {
      if (initial) updateSyncState("loading");
      try {
        const snapshot = await getDailyTasks();
        if (!mountedRef.current) return;
        setApiAvailable(true);
        if (dirtyRef.current || localDraftRef.current || syncStateRef.current === "saving") {
          if (snapshot.hash !== hashRef.current) {
            setConflictSnapshot(snapshot);
            setMessage("Obsidian 中的任务已更新，请选择保留的版本");
            updateSyncState("conflict");
          }
          return;
        }
        if (initial || snapshot.hash !== hashRef.current) applySnapshot(snapshot);
      } catch (error) {
        if (!mountedRef.current) return;
        if (error instanceof DailyTasksNotFoundError) {
          setApiAvailable(true);
          if (!dirtyRef.current) {
            const nextTasks = fallbackRef.current;
            hashRef.current = null;
            dirtyRef.current = false;
            tasksRef.current = nextTasks;
            setTasks(nextTasks);
            setUpdatedAt(null);
            setMessage(null);
            updateSyncState("unsaved");
          }
          return;
        }
        if (initial || !dirtyRef.current) {
          setApiAvailable(false);
          setMessage(errorMessage(error));
          updateSyncState("error");
        }
      }
    },
    [applySnapshot, updateSyncState]
  );

  useEffect(() => {
    mountedRef.current = true;
    void load(true);
    return () => {
      mountedRef.current = false;
    };
  }, [load]);

  useVaultSync(["daily-tasks"], () => load(false));

  const save = useCallback(
    async (nextTasks: TodayTask[]) => {
      if (!apiAvailable || syncStateRef.current === "saving") return false;
      const normalized = nextTasks
        .slice(0, 3)
        .map((task) => ({ ...task, title: task.title.trim() }))
        .filter((task) => task.title.length > 0);

      tasksRef.current = normalized;
      dirtyRef.current = true;
      setTasks(normalized);
      setMessage(null);
      setConflictSnapshot(null);
      updateSyncState("saving");

      try {
        const snapshot = await putDailyTasks(normalized, hashRef.current);
        if (!mountedRef.current) return false;
        applySnapshot(snapshot);
        return true;
      } catch (error) {
        if (!mountedRef.current) return false;
        if (error instanceof DailyTasksConflictError) {
          setConflictSnapshot(error.snapshot);
          setMessage("Obsidian 中的任务已更新，当前改动尚未覆盖");
          updateSyncState("conflict");
        } else {
          setMessage(errorMessage(error));
          updateSyncState("error");
        }
        return false;
      }
    },
    [apiAvailable, applySnapshot, updateSyncState]
  );

  const retry = useCallback(async () => {
    if (dirtyRef.current) return save(tasksRef.current);
    await load(true);
    return true;
  }, [load, save]);

  const acceptExternal = useCallback(() => {
    if (conflictSnapshot) applySnapshot(conflictSnapshot);
  }, [applySnapshot, conflictSnapshot]);

  return {
    date,
    tasks,
    syncState,
    updatedAt,
    message,
    canEdit:
      apiAvailable &&
      syncState !== "loading" &&
      syncState !== "saving" &&
      syncState !== "conflict",
    save,
    retry,
    acceptExternal,
  };
}
