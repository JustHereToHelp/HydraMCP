/**
 * Session Reader — reads Claude Code session files from disk.
 *
 * Claude Code stores conversations as JSONL files in ~/.claude/projects/.
 * This module reads them server-side so Claude never sees the raw data.
 * Only a compact summary gets returned to Claude's context window.
 *
 * Directory structure:
 *   ~/.claude/projects/C--Users-Beast-Documents-GitHub-HydraMCP/
 *     ├── [UUID].jsonl          (session file)
 *     └── [UUID]/subagents/     (subagent files, ignored)
 *
 *   ~/.claude/history.jsonl     (global index with timestamps + project paths)
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, basename, sep } from "node:path";
import { homedir } from "node:os";
import { logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionEntry {
  type: "user" | "assistant" | "tool_use" | "tool_result";
  content: string;
  timestamp: string;
  model?: string;
}

export interface SessionData {
  sessionId: string;
  entries: SessionEntry[];
  startTime: string;
  endTime: string;
  totalChars: number;
}

export interface SessionBundle {
  sessions: SessionData[];
  projectPath: string;
  totalChars: number;
  sessionCount: number;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Resolve the Claude data directory. Supports CLAUDE_DATA_DIR env override. */
export function getClaudeDataDir(): string {
  if (process.env.CLAUDE_DATA_DIR) {
    return process.env.CLAUDE_DATA_DIR;
  }
  return join(homedir(), ".claude");
}

/** Resolve the projects directory inside Claude's data dir. */
export function getClaudeProjectsDir(): string {
  return join(getClaudeDataDir(), "projects");
}

/**
 * Encode a project path to match Claude's directory naming convention.
 * "C:\Users\Beast\Documents" → "C--Users-Beast-Documents"
 * "/home/user/project" → "-home-user-project"
 */
export function encodeProjectPath(projectPath: string): string {
  // Normalize separators to forward slash first
  let normalized = projectPath.replace(/\\/g, "/");

  // Remove trailing slash
  normalized = normalized.replace(/\/+$/, "");

  // Replace colons and slashes with hyphens
  // "C:/Users/Beast" → "C-/Users/Beast" → "C--Users-Beast"
  // The colon becomes a dash (not removed), so C: → C-, then / → -, giving C--
  return normalized.replace(/:/g, "-").replace(/\//g, "-");
}

// ---------------------------------------------------------------------------
// Project discovery
// ---------------------------------------------------------------------------

/** List all available project directory names under ~/.claude/projects/. */
export function listProjects(): string[] {
  const projectsDir = getClaudeProjectsDir();
  if (!existsSync(projectsDir)) return [];

  try {
    return readdirSync(projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * Auto-detect the most recently used project by reading history.jsonl.
 * Returns the encoded project directory name, or null if not found.
 */
export function detectRecentProject(): string | null {
  const historyPath = join(getClaudeDataDir(), "history.jsonl");
  if (!existsSync(historyPath)) return null;

  try {
    const content = readFileSync(historyPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);

    // Read from the end — most recent entry is last
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.project) {
          const encoded = encodeProjectPath(entry.project);
          const projectsDir = getClaudeProjectsDir();
          const fullPath = join(projectsDir, encoded);
          if (existsSync(fullPath)) return encoded;
        }
      } catch {
        continue; // skip malformed lines
      }
    }
  } catch {
    // history.jsonl unreadable
  }

  return null;
}

// ---------------------------------------------------------------------------
// Session file discovery
// ---------------------------------------------------------------------------

/**
 * Find the N most recent session .jsonl files in a project directory.
 * Sorted by modification time, most recent first.
 */
export function findRecentSessions(projectDir: string, count: number): string[] {
  if (!existsSync(projectDir)) return [];

  try {
    const files = readdirSync(projectDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const fullPath = join(projectDir, f);
        const stat = statSync(fullPath);
        return { path: fullPath, mtime: stat.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime) // newest first
      .slice(0, count);

    return files.map((f) => f.path);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Sensitive data stripping
// ---------------------------------------------------------------------------

const SENSITIVE_PATTERNS = [
  /sk-[a-zA-Z0-9_-]{20,}/g,            // OpenAI API keys
  /key-[a-zA-Z0-9_-]{20,}/g,           // Generic API keys
  /AIza[a-zA-Z0-9_-]{30,}/g,           // Google API keys
  /ghp_[a-zA-Z0-9]{36,}/g,             // GitHub personal access tokens
  /gho_[a-zA-Z0-9]{36,}/g,             // GitHub OAuth tokens
  /glpat-[a-zA-Z0-9_-]{20,}/g,         // GitLab tokens
  /xoxb-[a-zA-Z0-9-]+/g,              // Slack bot tokens
  /xoxp-[a-zA-Z0-9-]+/g,              // Slack user tokens
  /Bearer\s+[a-zA-Z0-9._-]{20,}/gi,   // Bearer tokens
  /password\s*[:=]\s*["']?[^\s"']{8,}/gi, // password assignments
];

function stripSensitiveData(text: string): string {
  let result = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

// ---------------------------------------------------------------------------
// JSONL parsing
// ---------------------------------------------------------------------------

/**
 * Extract meaningful content from a single JSONL line.
 * Returns a SessionEntry or null if the line should be skipped.
 */
function parseLine(line: string): SessionEntry | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }

  // Skip noise types
  const type = obj.type as string;
  if (type === "file-history-snapshot") return null;
  if (type === "progress") return null;

  // Skip sidechains
  if (obj.isSidechain === true) return null;

  const message = obj.message as Record<string, unknown> | undefined;
  if (!message) return null;

  const timestamp = (obj.timestamp as string) ?? "";
  const role = message.role as string;
  const content = message.content;

  // --- User message (plain text prompt) ---
  if (type === "user" && role === "user" && typeof content === "string") {
    return {
      type: "user",
      content: stripSensitiveData(content),
      timestamp,
    };
  }

  // --- Content is an array (assistant responses, tool_use, tool_result) ---
  if (Array.isArray(content)) {
    // Check for tool_result entries (user role with tool results)
    const toolResults = content.filter(
      (c: Record<string, unknown>) => c.type === "tool_result"
    );
    if (toolResults.length > 0 && role === "user") {
      const resultTexts = toolResults
        .map((r: Record<string, unknown>) => {
          const text = typeof r.content === "string" ? r.content : "";
          // Truncate verbose tool outputs
          return text.length > 500 ? text.slice(0, 500) + "..." : text;
        })
        .filter(Boolean);

      if (resultTexts.length > 0) {
        return {
          type: "tool_result",
          content: stripSensitiveData(resultTexts.join("\n")),
          timestamp,
        };
      }
      return null;
    }

    // Assistant message content blocks
    if (role === "assistant") {
      const model = (message.model as string) ?? undefined;
      const parts: string[] = [];

      for (const block of content as Record<string, unknown>[]) {
        const blockType = block.type as string;

        // Skip thinking blocks — huge, internal reasoning
        if (blockType === "thinking") continue;

        // Text response
        if (blockType === "text" && typeof block.text === "string") {
          const text = block.text.trim();
          if (text) parts.push(text);
        }

        // Tool use — just capture the tool name and brief description
        if (blockType === "tool_use") {
          const toolName = block.name as string;
          const input = block.input as Record<string, unknown> | undefined;
          const desc =
            (input?.description as string) ??
            (input?.command as string) ??
            (input?.file_path as string) ??
            (input?.pattern as string) ??
            "";
          const brief = desc.length > 200 ? desc.slice(0, 200) + "..." : desc;
          parts.push(`[Tool: ${toolName}] ${brief}`);
        }
      }

      if (parts.length > 0) {
        const combinedContent = stripSensitiveData(parts.join("\n"));
        // Determine if this is primarily tool_use
        const hasOnlyToolUse = parts.every((p) => p.startsWith("[Tool:"));
        return {
          type: hasOnlyToolUse ? "tool_use" : "assistant",
          content: combinedContent,
          timestamp,
          model,
        };
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Session parsing
// ---------------------------------------------------------------------------

/** Parse a single session .jsonl file into structured SessionData. */
export function parseSession(filePath: string): SessionData {
  const sessionId = basename(filePath, ".jsonl");
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter(Boolean);

  const entries: SessionEntry[] = [];
  for (const line of lines) {
    const entry = parseLine(line);
    if (entry) entries.push(entry);
  }

  const timestamps = entries
    .map((e) => e.timestamp)
    .filter(Boolean)
    .sort();

  const totalChars = entries.reduce((sum, e) => sum + e.content.length, 0);

  return {
    sessionId,
    entries,
    startTime: timestamps[0] ?? "",
    endTime: timestamps[timestamps.length - 1] ?? "",
    totalChars,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/** Maximum characters to include across all sessions (~800K for Gemini headroom). */
const MAX_TOTAL_CHARS = 800_000;

/**
 * Read N recent sessions for a project. If project is omitted, auto-detects
 * the most recently used project. Drops oldest entries first when truncating.
 */
export function readSessions(
  project: string | undefined,
  count: number
): SessionBundle {
  const projectsDir = getClaudeProjectsDir();

  // Resolve project directory
  let projectDirName: string;
  if (project) {
    projectDirName = encodeProjectPath(project);
  } else {
    const detected = detectRecentProject();
    if (!detected) {
      const available = listProjects();
      throw new Error(
        `No recent project detected. Available projects:\n${
          available.length > 0
            ? available.map((p) => `  - ${p}`).join("\n")
            : "  (none found)"
        }\n\nPass a project path explicitly.`
      );
    }
    projectDirName = detected;
  }

  const projectDir = join(projectsDir, projectDirName);
  if (!existsSync(projectDir)) {
    throw new Error(
      `Project directory not found: ${projectDirName}\n` +
        `Looked in: ${projectsDir}\n` +
        `Available: ${listProjects().join(", ") || "(none)"}`
    );
  }

  // Find session files
  const sessionFiles = findRecentSessions(projectDir, count);
  if (sessionFiles.length === 0) {
    throw new Error(`No session files found in ${projectDirName}`);
  }

  logger.info(
    `session-reader: found ${sessionFiles.length} sessions in ${projectDirName}`
  );

  // Parse sessions (newest first) with truncation
  const sessions: SessionData[] = [];
  let totalChars = 0;
  let truncated = false;

  for (const file of sessionFiles) {
    const session = parseSession(file);

    if (totalChars + session.totalChars > MAX_TOTAL_CHARS) {
      // Truncate this session — keep newest entries
      const remaining = MAX_TOTAL_CHARS - totalChars;
      if (remaining <= 0) {
        truncated = true;
        break;
      }

      // Walk entries from the end (newest), accumulate until budget exhausted
      const keptEntries: SessionEntry[] = [];
      let charBudget = remaining;
      for (let i = session.entries.length - 1; i >= 0; i--) {
        const entry = session.entries[i];
        if (charBudget - entry.content.length < 0 && keptEntries.length > 0) {
          break;
        }
        keptEntries.unshift(entry);
        charBudget -= entry.content.length;
      }

      const truncatedChars = keptEntries.reduce(
        (s, e) => s + e.content.length,
        0
      );
      sessions.push({
        ...session,
        entries: keptEntries,
        totalChars: truncatedChars,
      });
      totalChars += truncatedChars;
      truncated = true;
      break;
    }

    sessions.push(session);
    totalChars += session.totalChars;
  }

  if (truncated) {
    logger.warn(
      `session-reader: truncated to ${totalChars} chars (limit: ${MAX_TOTAL_CHARS})`
    );
  }

  return {
    sessions,
    projectPath: projectDirName,
    totalChars,
    sessionCount: sessions.length,
  };
}

/**
 * Format session data as a string suitable for sending to a model.
 * Groups entries by session with timestamps.
 */
export function formatSessionsForPrompt(bundle: SessionBundle): string {
  const parts: string[] = [];

  for (const session of bundle.sessions) {
    parts.push(
      `=== Session: ${session.sessionId} (${session.startTime} to ${session.endTime}) ===`
    );
    parts.push("");

    for (const entry of session.entries) {
      const prefix =
        entry.type === "user"
          ? "USER"
          : entry.type === "tool_use"
            ? "TOOL_CALL"
            : entry.type === "tool_result"
              ? "TOOL_OUTPUT"
              : "ASSISTANT";

      parts.push(`[${prefix}] ${entry.content}`);
      parts.push("");
    }

    parts.push("");
  }

  return parts.join("\n");
}
