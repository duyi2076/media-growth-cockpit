import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActionTargetsApiError,
  ActionTargetsConflictError,
  getActionTargets,
  putActionTargets,
  type ActionTargetsSnapshot,
  type EditableActionTarget,
} from "@/data/actionTargetsClient";
import type { ActionTarget, ActionTargetId } from "@/types";
import { useVaultSync } from "@/hooks/useVaultSync";

export type ActionTargetSyncState = "loading" | "saved" | "saving" | "error" | "conflict";

export function useActionTargets(initial: ActionTarget[]) {
  const [targets, setTargets] = useState<ActionTarget[]>(initial);
  const [campaignStartedAt, setCampaignStartedAt] = useState<string | null>(null);
  const [state, setState] = useState<ActionTargetSyncState>("loading");
  const [message, setMessage] = useState<string | null>(null);
  const hashRef = useRef<string | null>(null);
  const targetsRef = useRef(targets);
  const conflictRef = useRef<ActionTargetsSnapshot | null>(null);
  const snapshotRef = useRef<ActionTargetsSnapshot | null>(null);
  const savingRef = useRef(false);
  const editingRef = useRef(false);

  useEffect(() => { targetsRef.current = targets; }, [targets]);

  const applySnapshot = useCallback((snapshot: ActionTargetsSnapshot) => {
    const values = new Map(snapshot.targets.map((item) => [item.id, item.target]));
    snapshotRef.current = snapshot;
    hashRef.current = snapshot.hash;
    setCampaignStartedAt(snapshot.campaignStartedAt);
    conflictRef.current = null;
    setTargets((current) => current.map((item) => {
      const target = values.get(item.id) ?? null;
      return {
        ...item,
        target,
        completionRate: target === null ? null : item.current / target,
      };
    }));
    setMessage(null);
    setState("saved");
  }, []);

  const load = useCallback(async () => {
    try {
      const snapshot = await getActionTargets();
      if (savingRef.current) return;
      if (hashRef.current !== snapshot.hash && editingRef.current) {
        conflictRef.current = snapshot;
        setMessage("Obsidian 中的目标已更新，请先载入最新版本");
        setState("conflict");
      } else if (hashRef.current !== snapshot.hash) applySnapshot(snapshot);
      else setState("saved");
    } catch (error) {
      setMessage(error instanceof ActionTargetsApiError ? error.message : "行动目标暂时无法读取");
      setState("error");
    }
  }, [applySnapshot]);

  useEffect(() => {
    const liveValues = snapshotRef.current
      ? new Map(snapshotRef.current.targets.map((item) => [item.id, item.target]))
      : null;
    setTargets((current) => initial.map((item) => {
      const live = current.find((candidate) => candidate.id === item.id);
      const target = liveValues?.get(item.id) ?? live?.target ?? item.target;
      return { ...item, target, completionRate: target === null ? null : item.current / target };
    }));
  }, [initial]);

  useEffect(() => {
    void load();
  }, [load]);

  useVaultSync(["action-targets"], load);

  const saveTarget = useCallback(async (id: ActionTargetId, target: number | null) => {
    if (!hashRef.current || savingRef.current || conflictRef.current) return false;
    const next = targetsRef.current.map((item) => ({
      id: item.id,
      target: item.id === id ? target : item.target,
    })) satisfies EditableActionTarget[];
    savingRef.current = true;
    setState("saving");
    setMessage(null);
    try {
      const snapshot = await putActionTargets(next, hashRef.current);
      applySnapshot(snapshot);
      return true;
    } catch (error) {
      if (error instanceof ActionTargetsConflictError) {
        conflictRef.current = error.snapshot;
        setMessage("Obsidian 中的目标已更新，请先载入最新版本");
        setState("conflict");
      } else {
        setMessage(error instanceof ActionTargetsApiError ? error.message : "行动目标暂时无法保存");
        setState("error");
      }
      return false;
    } finally {
      savingRef.current = false;
    }
  }, [applySnapshot]);

  const acceptExternal = useCallback(() => {
    if (conflictRef.current) applySnapshot(conflictRef.current);
  }, [applySnapshot]);

  const startCampaign = useCallback(async () => {
    if (!hashRef.current || savingRef.current || campaignStartedAt) return false;
    const next = targetsRef.current.map((item) => ({ id: item.id, target: item.target })) satisfies EditableActionTarget[];
    savingRef.current = true;
    setState("saving");
    setMessage(null);
    try {
      const snapshot = await putActionTargets(next, hashRef.current, true);
      applySnapshot(snapshot);
      return true;
    } catch (error) {
      if (error instanceof ActionTargetsConflictError) {
        conflictRef.current = error.snapshot;
        setMessage("Obsidian 中的目标已更新，请先载入最新版本");
        setState("conflict");
      } else {
        setMessage(error instanceof ActionTargetsApiError ? error.message : "正式开始时间暂时无法保存");
        setState("error");
      }
      return false;
    } finally {
      savingRef.current = false;
    }
  }, [applySnapshot, campaignStartedAt]);

  const beginEditing = useCallback(() => { editingRef.current = true; }, []);
  const endEditing = useCallback(() => { editingRef.current = false; }, []);

  return { targets, campaignStartedAt, state, message, saveTarget, startCampaign, retry: load, acceptExternal, beginEditing, endEditing };
}
