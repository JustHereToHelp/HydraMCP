/**
 * Logger — writes to stderr, never stdout.
 *
 * MCP uses stdout for JSON-RPC communication.
 * If we write anything to stdout that isn't valid JSON-RPC,
 * the MCP client (Claude Code) will choke. So all debug/info/error
 * logging goes to stderr, which Claude Code ignores.
 */

import crypto from "node:crypto";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const minLevel: LogLevel = (process.env.HYDRA_LOG_LEVEL as LogLevel) ?? "info";

function log(level: LogLevel, message: string): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[minLevel]) return;
  const timestamp = new Date().toISOString();
  process.stderr.write(`[${timestamp}] [${level.toUpperCase()}] ${message}\n`);
}

export const logger = {
  debug: (msg: string) => log("debug", msg),
  info: (msg: string) => log("info", msg),
  warn: (msg: string) => log("warn", msg),
  error: (msg: string) => log("error", msg),
};

export function createRequestLogger(requestId: string) {
  const prefix = `[req:${requestId}]`;
  return {
    debug: (msg: string) => log("debug", `${prefix} ${msg}`),
    info: (msg: string) => log("info", `${prefix} ${msg}`),
    warn: (msg: string) => log("warn", `${prefix} ${msg}`),
    error: (msg: string) => log("error", `${prefix} ${msg}`),
  };
}

export function logQuery(data: {
  requestId: string;
  model: string;
  latency_ms: number;
  status: string;
  finish_reason?: string;
}): void {
  logger.info(JSON.stringify({ type: "query", ...data }));
}

export function generateRequestId(): string {
  return crypto.randomUUID().slice(0, 8);
}
