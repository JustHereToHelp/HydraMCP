/**
 * Fetch with timeout — wraps native fetch() with AbortController-based timeout.
 * Prevents hanging requests from blocking the entire server.
 */

export class TimeoutError extends Error {
  name = "TimeoutError" as const;
  constructor(url: string, timeoutMs: number) {
    super(`Request to ${url} timed out after ${timeoutMs}ms`);
  }
}

const DEFAULT_TIMEOUT_MS = parseInt(
  process.env.HYDRA_TOTAL_TIMEOUT_MS ?? "120000",
  10
);

export async function fetchWithTimeout(
  url: string | URL | Request,
  init?: RequestInit,
  timeoutMs?: number
): Promise<Response> {
  const ms = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);

  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    return res;
  } catch (err) {
    if (controller.signal.aborted) {
      throw new TimeoutError(String(url), ms);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
