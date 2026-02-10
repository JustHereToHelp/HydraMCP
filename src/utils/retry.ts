/**
 * Generic retry wrapper with exponential backoff.
 * Retries on transient errors (timeouts, network, 5xx) but not on client errors (4xx).
 */

import { logger } from "../utils/logger.js";

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

const NON_RETRYABLE_CODES = ["400", "401", "403", "404"];
const RETRYABLE_CODES = ["429", "500", "502", "503", "504"];

function isNonRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return NON_RETRYABLE_CODES.some((code) => err.message.includes(code));
}

function isRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "TimeoutError") return true;
  if (err instanceof TypeError) return true;
  return RETRYABLE_CODES.some((code) => err.message.includes(code));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions
): Promise<T> {
  const maxRetries = options?.maxRetries ?? 2;
  const baseDelayMs = options?.baseDelayMs ?? 500;
  const maxDelayMs = options?.maxDelayMs ?? 5000;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (isNonRetryable(err)) throw err;
      if (attempt >= maxRetries || !isRetryable(err)) throw err;

      const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
      logger.warn(
        `Retry ${attempt + 1}/${maxRetries} after ${delay}ms — ${err instanceof Error ? err.message : String(err)}`
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastError;
}
