import { useEffect, useRef } from "react";

export type VaultEventScope =
  | "all"
  | "index"
  | "content-assets"
  | "daily-tasks"
  | "action-targets"
  | "platform-followers"
  | "review-assets"
  | "daily-reviews"
  | "cockpit-settings";

type VaultChangeEvent = {
  id: string;
  scope: Exclude<VaultEventScope, "all">;
  changedAt: string;
};

type Listener = (event: VaultChangeEvent | { id: "reconnected" | "disconnected"; scope: "all"; changedAt: string }) => void;
type SyncEvent = Parameters<Listener>[0];

const SYNC_CHANNEL_NAME = "creator-cockpit-vault-events-v1";
const SYNC_LOCK_NAME = "creator-cockpit-vault-events-leader-v1";
const KNOWN_SCOPES = new Set<VaultEventScope>([
  "all",
  "index",
  "content-assets",
  "daily-tasks",
  "action-targets",
  "platform-followers",
  "review-assets",
  "daily-reviews",
  "cockpit-settings",
]);

const listeners = new Set<Listener>();
let source: EventSource | null = null;
let visibilityListenerInstalled = false;
let coordinatedAcrossTabs = false;
let channel: BroadcastChannel | null = null;
let leadershipAttemptPending = false;
let leadershipRetryTimer: number | null = null;
let releaseLeadership: (() => void) | null = null;

function notify(event: Parameters<Listener>[0]) {
  for (const listener of listeners) listener(event);
}

function isSyncEvent(value: unknown): value is SyncEvent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SyncEvent>;
  return typeof candidate.id === "string"
    && typeof candidate.scope === "string"
    && KNOWN_SCOPES.has(candidate.scope as VaultEventScope)
    && typeof candidate.changedAt === "string";
}

function distributeEvent(event: SyncEvent, broadcast: boolean) {
  notify(event);
  if (broadcast) channel?.postMessage({ kind: "vault-event", event });
}

function ensureEventSource(broadcast = false) {
  if (
    source
    || typeof window === "undefined"
    || typeof window.EventSource === "undefined"
    || (!coordinatedAcrossTabs && document.visibilityState === "hidden")
  ) return;
  const next = new window.EventSource("/api/vault-events");
  next.addEventListener("vault-change", (rawEvent) => {
    try {
      const event = JSON.parse((rawEvent as MessageEvent<string>).data) as VaultChangeEvent;
      if (!event.id || !event.scope || !event.changedAt) return;
      distributeEvent(event, broadcast);
    } catch {
      // 丢弃结构异常的本地事件，等待下一次有效通知或页面重新聚焦校准。
    }
  });
  next.addEventListener("open", () => {
    distributeEvent({ id: "reconnected", scope: "all", changedAt: new Date().toISOString() }, broadcast);
  });
  next.addEventListener("error", () => {
    distributeEvent({ id: "disconnected", scope: "all", changedAt: new Date().toISOString() }, broadcast);
  });
  source = next;
}

function closeEventSource() {
  source?.close();
  source = null;
}

function syncEventSourceVisibility() {
  if (coordinatedAcrossTabs) return;
  if (document.visibilityState === "hidden") {
    closeEventSource();
    return;
  }
  if (listeners.size > 0) ensureEventSource();
}

function supportsCrossTabCoordination() {
  return typeof window !== "undefined"
    && typeof window.BroadcastChannel !== "undefined"
    && typeof navigator !== "undefined"
    && typeof navigator.locks?.request === "function";
}

function scheduleLeadershipAttempt(delay = 2_000 + Math.floor(Math.random() * 1_000)) {
  if (!coordinatedAcrossTabs || listeners.size === 0 || leadershipRetryTimer !== null) return;
  leadershipRetryTimer = window.setTimeout(() => {
    leadershipRetryTimer = null;
    attemptLeadership();
  }, delay);
}

function attemptLeadership() {
  if (
    !coordinatedAcrossTabs
    || listeners.size === 0
    || leadershipAttemptPending
    || releaseLeadership
  ) return;
  leadershipAttemptPending = true;
  void navigator.locks.request(
    SYNC_LOCK_NAME,
    { mode: "exclusive", ifAvailable: true },
    async (lock) => {
      leadershipAttemptPending = false;
      if (!lock || listeners.size === 0 || !coordinatedAcrossTabs) return;
      ensureEventSource(true);
      await new Promise<void>((resolve) => { releaseLeadership = resolve; });
      releaseLeadership = null;
      closeEventSource();
      channel?.postMessage({ kind: "leader-released" });
    },
  ).catch(() => {
    // Older embedded browsers fall back to the visible-tab strategy.
    coordinatedAcrossTabs = false;
    channel?.close();
    channel = null;
    installVisibilityListener();
    syncEventSourceVisibility();
  }).finally(() => {
    leadershipAttemptPending = false;
    scheduleLeadershipAttempt();
  });
}

function beginCrossTabCoordination() {
  if (!supportsCrossTabCoordination()) return false;
  if (!channel) {
    channel = new window.BroadcastChannel(SYNC_CHANNEL_NAME);
    channel.addEventListener("message", (message) => {
      const value = message.data as { kind?: unknown; event?: unknown } | null;
      if (value?.kind === "vault-event" && isSyncEvent(value.event)) {
        notify(value.event);
      } else if (value?.kind === "leader-released") {
        scheduleLeadershipAttempt(Math.floor(Math.random() * 250));
      }
    });
  }
  coordinatedAcrossTabs = true;
  attemptLeadership();
  return true;
}

function stopCrossTabCoordination() {
  if (leadershipRetryTimer !== null) window.clearTimeout(leadershipRetryTimer);
  leadershipRetryTimer = null;
  const release = releaseLeadership;
  releaseLeadership = null;
  release?.();
  closeEventSource();
  channel?.close();
  channel = null;
  coordinatedAcrossTabs = false;
}

function installVisibilityListener() {
  if (visibilityListenerInstalled || typeof document === "undefined") return;
  document.addEventListener("visibilitychange", syncEventSourceVisibility);
  visibilityListenerInstalled = true;
}

function uninstallVisibilityListener() {
  if (!visibilityListenerInstalled || typeof document === "undefined") return;
  document.removeEventListener("visibilitychange", syncEventSourceVisibility);
  visibilityListenerInstalled = false;
}

function subscribe(listener: Listener) {
  listeners.add(listener);
  if (!beginCrossTabCoordination()) {
    installVisibilityListener();
    ensureEventSource();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopCrossTabCoordination();
      closeEventSource();
      uninstallVisibilityListener();
    }
  };
}

export function useVaultSync(
  scopes: VaultEventScope[],
  refresh: () => void | Promise<void>,
) {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const scopeKey = [...scopes].sort().join("|");

  useEffect(() => {
    const accepted = new Set<VaultEventScope>(scopeKey.split("|") as VaultEventScope[]);
    return subscribe((event) => {
      if (event.scope !== "all" && !accepted.has(event.scope)) return;
      void Promise.resolve(refreshRef.current()).catch(() => {});
    });
  }, [scopeKey]);

  useEffect(() => {
    let scheduled = false;
    let timer: number | null = null;
    const refreshWhenActive = () => {
      if (document.visibilityState === "hidden" || scheduled) return;
      scheduled = true;
      timer = window.setTimeout(() => {
        timer = null;
        scheduled = false;
        void Promise.resolve(refreshRef.current()).catch(() => {});
      }, 0);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refreshWhenActive();
    };
    window.addEventListener("focus", refreshWhenActive);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", refreshWhenActive);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);
}
