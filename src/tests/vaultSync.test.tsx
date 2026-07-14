import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useVaultSync } from "@/hooks/useVaultSync";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, Array<(event: Event | MessageEvent<string>) => void>>();
  closed = false;

  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: Event | MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(type: string, event: Event | MessageEvent<string>) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  close() {
    this.closed = true;
  }
}

function Harness({ refresh }: { refresh: () => void }) {
  useVaultSync(["content-assets"], refresh);
  return null;
}

afterEach(() => {
  cleanup();
  FakeEventSource.instances = [];
  vi.unstubAllGlobals();
});

describe("V2 事件同步", () => {
  it("uses one SSE connection and refreshes only for subscribed file changes", () => {
    vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
    const refresh = vi.fn();
    render(<Harness refresh={refresh} />);

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toBe("/api/vault-events");

    FakeEventSource.instances[0].emit("vault-change", new MessageEvent("vault-change", {
      data: JSON.stringify({ id: "1", scope: "platform-followers", changedAt: "2026-07-13T00:00:00.000Z" }),
    }));
    expect(refresh).not.toHaveBeenCalled();

    FakeEventSource.instances[0].emit("vault-change", new MessageEvent("vault-change", {
      data: JSON.stringify({ id: "2", scope: "content-assets", changedAt: "2026-07-13T00:00:01.000Z" }),
    }));
    expect(refresh).toHaveBeenCalledTimes(1);

    FakeEventSource.instances[0].emit("error", new Event("error"));
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("releases the SSE connection in background tabs and reconnects when visible", () => {
    vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const refresh = vi.fn();
    render(<Harness refresh={refresh} />);

    expect(FakeEventSource.instances).toHaveLength(1);
    visibility.mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    expect(FakeEventSource.instances[0].closed).toBe(true);

    visibility.mockReturnValue("visible");
    fireEvent(document, new Event("visibilitychange"));
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1].closed).toBe(false);
  });
});
