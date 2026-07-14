import { useCallback, useEffect, useRef, useState } from "react";
import {
  getPlatformFollowers,
  putPlatformFollowers,
  PlatformFollowersApiError,
  PlatformFollowersConflictError,
  type PlatformFollowersSnapshot,
} from "@/data/platformFollowersClient";
import type { PlatformAccount } from "@/types";
import { useVaultSync } from "@/hooks/useVaultSync";

export type PlatformFollowersState = "loading" | "saved" | "saving" | "error" | "conflict";

export function usePlatformFollowers(initial: PlatformAccount[], refreshIndex: () => Promise<void>) {
  const [accounts, setAccounts] = useState(initial);
  const [state, setState] = useState<PlatformFollowersState>("loading");
  const [message, setMessage] = useState<string | null>(null);
  const hashRef = useRef<string | null>(null);
  const accountsRef = useRef(accounts);
  const savingRef = useRef(false);
  const editingRef = useRef(false);
  const conflictRef = useRef<PlatformFollowersSnapshot | null>(null);
  const snapshotRef = useRef<PlatformFollowersSnapshot | null>(null);

  useEffect(() => { accountsRef.current = accounts; }, [accounts]);

  const applySnapshot = useCallback((snapshot: PlatformFollowersSnapshot) => {
    const live = new Map(snapshot.accounts.map((account) => [account.id, account]));
    snapshotRef.current = snapshot;
    hashRef.current = snapshot.hash;
    conflictRef.current = null;
    setAccounts((current) => current.map((account) => {
      const value = live.get(account.id);
      if (!value) return account;
      return {
        ...account,
        currentFollowers: value.currentFollowers,
        followerGrowth: value.currentFollowers - account.baselineFollowers,
        asOf: value.asOf,
      };
    }));
    setMessage(null);
    setState("saved");
  }, []);

  const load = useCallback(async () => {
    try {
      const snapshot = await getPlatformFollowers();
      if (savingRef.current) return;
      if (snapshot.hash !== hashRef.current && editingRef.current) {
        conflictRef.current = snapshot;
        setMessage("Obsidian 中的平台粉丝已更新，请载入最新值");
        setState("conflict");
      } else if (snapshot.hash !== hashRef.current) applySnapshot(snapshot);
      else setState("saved");
    } catch (error) {
      setMessage(error instanceof PlatformFollowersApiError ? error.message : "平台粉丝暂时无法读取");
      setState("error");
    }
  }, [applySnapshot]);

  useEffect(() => {
    const live = snapshotRef.current
      ? new Map(snapshotRef.current.accounts.map((account) => [account.id, account]))
      : null;
    setAccounts((current) => initial.map((account) => {
      const currentAccount = current.find((item) => item.id === account.id);
      const snapshotAccount = live?.get(account.id);
      const currentFollowers = snapshotAccount?.currentFollowers ?? currentAccount?.currentFollowers ?? account.currentFollowers;
      return {
        ...account,
        currentFollowers,
        followerGrowth: currentFollowers - account.baselineFollowers,
        asOf: snapshotAccount?.asOf ?? currentAccount?.asOf ?? account.asOf,
      };
    }));
  }, [initial]);

  useEffect(() => {
    void load();
  }, [load]);

  useVaultSync(["platform-followers"], load);

  const saveFollower = useCallback(async (id: string, currentFollowers: number) => {
    if (!hashRef.current || savingRef.current || conflictRef.current) return false;
    const next = accountsRef.current.map((account) => ({ id: account.id, currentFollowers: account.id === id ? currentFollowers : account.currentFollowers }));
    savingRef.current = true;
    setState("saving");
    setMessage(null);
    try {
      const snapshot = await putPlatformFollowers(next, hashRef.current);
      applySnapshot(snapshot);
      try {
        await refreshIndex();
      } catch {
        setMessage("粉丝数已保存，页面摘要暂未刷新，点击可重新读取");
        setState("error");
      }
      return true;
    } catch (error) {
      if (error instanceof PlatformFollowersConflictError) {
        conflictRef.current = error.snapshot;
        setMessage("Obsidian 中的平台粉丝已更新，请载入最新值");
        setState("conflict");
      } else {
        setMessage(error instanceof PlatformFollowersApiError ? error.message : "平台粉丝暂时无法保存");
        setState("error");
      }
      return false;
    } finally {
      savingRef.current = false;
    }
  }, [applySnapshot, refreshIndex]);

  const acceptExternal = useCallback(() => {
    if (conflictRef.current) applySnapshot(conflictRef.current);
  }, [applySnapshot]);

  const beginEditing = useCallback(() => { editingRef.current = true; }, []);
  const endEditing = useCallback(() => { editingRef.current = false; }, []);

  return { accounts, state, message, saveFollower, retry: load, acceptExternal, beginEditing, endEditing };
}
