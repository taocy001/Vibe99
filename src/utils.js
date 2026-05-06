/**
 * Throttle fn so it is called at most once per animation frame.
 * The last event received within a frame is the one delivered.
 * Returns a throttled function with a .cancel() method.
 *
 * @template {(...args: any[]) => void} T
 * @param {T} fn
 * @returns {T & { cancel(): void }}
 */
export function rafThrottle(fn) {
  let raf = null, latest = null;
  function throttled(e) {
    latest = e;
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = null; fn(latest); });
  }
  throttled.cancel = () => { if (raf !== null) { cancelAnimationFrame(raf); raf = null; } };
  return throttled;
}
