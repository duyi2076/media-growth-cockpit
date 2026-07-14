import { afterEach, describe, expect, it, vi } from "vitest";
import { timeoutSignal } from "@/data/timeoutSignal";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("request timeout signal", () => {
  it("combines a page lifecycle cancellation with the request timeout", () => {
    const external = new AbortController();
    const combined = timeoutSignal(8_000, external.signal);
    const reason = new DOMException("page closed", "AbortError");
    external.abort(reason);
    expect(combined.aborted).toBe(true);
    expect(combined.reason).toBe(reason);
    expect(combined.reason.name).toBe("AbortError");
  });

  it("falls back when the browser does not implement AbortSignal.timeout", () => {
    vi.useFakeTimers();
    const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
    Object.defineProperty(AbortSignal, "timeout", { value: undefined, configurable: true });
    try {
      const external = new AbortController();
      const signal = timeoutSignal(100, external.signal);
      expect(signal.aborted).toBe(false);
      vi.advanceTimersByTime(100);
      expect(signal.aborted).toBe(true);
      expect(signal.reason).toBeInstanceOf(DOMException);
      expect(signal.reason.name).toBe("TimeoutError");

      external.abort(new DOMException("page closed", "AbortError"));
      expect(signal.reason.name).toBe("TimeoutError");
    } finally {
      if (descriptor) Object.defineProperty(AbortSignal, "timeout", descriptor);
    }
  });

  it("keeps an earlier lifecycle abort when the fallback timer fires later", () => {
    vi.useFakeTimers();
    const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
    Object.defineProperty(AbortSignal, "timeout", { value: undefined, configurable: true });
    try {
      const external = new AbortController();
      const signal = timeoutSignal(100, external.signal);
      const reason = new DOMException("page closed", "AbortError");
      external.abort(reason);
      vi.advanceTimersByTime(100);
      expect(signal.reason).toBe(reason);
      expect(signal.reason.name).toBe("AbortError");
    } finally {
      if (descriptor) Object.defineProperty(AbortSignal, "timeout", descriptor);
    }
  });
});
