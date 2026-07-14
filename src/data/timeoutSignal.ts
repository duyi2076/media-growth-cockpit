export function timeoutSignal(milliseconds: number, external?: AbortSignal): AbortSignal {
  const nativeTimeout = typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(milliseconds)
    : null;
  if (!external && nativeTimeout) return nativeTimeout;
  if (external?.aborted) return external;

  const controller = new AbortController();
  const timer = nativeTimeout
    ? null
    : globalThis.setTimeout(() => {
      controller.abort(new DOMException("The operation timed out", "TimeoutError"));
    }, milliseconds);
  const abort = (signal: AbortSignal) => {
    if (timer !== null) globalThis.clearTimeout(timer);
    controller.abort(signal.reason);
  };
  nativeTimeout?.addEventListener("abort", () => abort(nativeTimeout), { once: true });
  external?.addEventListener("abort", () => abort(external), { once: true });
  return controller.signal;
}
