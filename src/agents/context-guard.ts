import { createMiddleware } from "langchain";
import { ToolMessage } from "@langchain/core/messages";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const BLOCKED_DIRECTORIES = new Set([
  "node_modules", ".git", ".next", ".nuxt", "dist", "build",
  ".cache", ".turbo", "__pycache__", "coverage", ".svelte-kit",
]);

const BLOCKED_GLOBS_PATTERNS = [
  /\.d\.ts$/,
  /\.map$/,
  /\.lock$/,
  /node_modules/,
  /\.git\//,
];

const fileReadCache = new Map<string, { summary: string; timestamp: number }>();

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes — files rarely change during a build session

function stringifyToolContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";

  if (content instanceof Uint8Array) {
    return `[binary content: ${content.byteLength} bytes]`;
  }

  if (ArrayBuffer.isView(content)) {
    return `[binary content: ${content.byteLength} bytes]`;
  }

  if (content instanceof ArrayBuffer) {
    return `[binary content: ${content.byteLength} bytes]`;
  }

  if (Array.isArray(content)) {
    return content.map((block) => {
      if (typeof block === "string") return block;
      if (block && typeof block === "object") {
        const maybeText = (block as any).text;
        if (typeof maybeText === "string") return maybeText;

        const maybeContent = (block as any).content;
        if (typeof maybeContent === "string") return maybeContent;
      }
      return safeStringify(block);
    }).join("\n");
  }

  if (content && typeof content === "object") {
    const maybeContent = (content as any).content;
    if (typeof maybeContent === "string") return maybeContent;
    return safeStringify(content);
  }

  return String(content);
}

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, current) => {
    if (current instanceof Uint8Array) {
      return `[binary content: ${current.byteLength} bytes]`;
    }
    if (ArrayBuffer.isView(current)) {
      return `[binary content: ${current.byteLength} bytes]`;
    }
    if (current instanceof ArrayBuffer) {
      return `[binary content: ${current.byteLength} bytes]`;
    }
    if (current && typeof current === "object") {
      if (seen.has(current)) return "[Circular]";
      seen.add(current);
    }
    return current;
  }, 2) ?? "";
}

function normalizeMessageContent(message: unknown): unknown {
  const looksLikeToolMessage = ToolMessage.isInstance(message)
    || Boolean(
      message
      && typeof message === "object"
      && (message as any).type === "tool"
      && "tool_call_id" in (message as any)
    );

  if (looksLikeToolMessage) {
    const toolMessage = message as any;
    if (typeof toolMessage.content !== "string") {
      toolMessage.content = stringifyToolContent(toolMessage.content);
    }
    return toolMessage;
  }
  return message;
}

export function normalizeToolResultContent(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;

  if (
    ToolMessage.isInstance(result)
    || Boolean((result as any).type === "tool" && "tool_call_id" in (result as any))
  ) {
    return normalizeMessageContent(result);
  }

  const value = result as any;
  if (Array.isArray(value.messages)) {
    value.messages = value.messages.map(normalizeMessageContent);
  }

  if (value.update && Array.isArray(value.update.messages)) {
    value.update.messages = value.update.messages.map(normalizeMessageContent);
  }

  if ("content" in value && typeof value.content !== "string") {
    value.content = stringifyToolContent(value.content);
  }

  return value;
}

function isBlockedPath(filePath: string): { blocked: boolean; reason: string } {
  const normalized = filePath.replace(/\\/g, "/");

  for (const dir of BLOCKED_DIRECTORIES) {
    if (normalized.includes(`/${dir}/`) || normalized.endsWith(`/${dir}`)) {
      const lastSegment = normalized.split("/").pop() ?? "";
      if (lastSegment === dir) {
        return { blocked: true, reason: `⛔ BLOCKED: Do not scan '${dir}'. This wastes context. Use package.json for dependency info.` };
      }
      if (normalized.includes(`/${dir}/`)) {
        return { blocked: true, reason: `⛔ BLOCKED: Do not scan '${dir}'. This wastes context. Use package.json for dependency info.` };
      }
    }
  }

  for (const pattern of BLOCKED_GLOBS_PATTERNS) {
    if (pattern.test(normalized)) {
      return { blocked: true, reason: `⛔ BLOCKED: File '${filePath}' matches blocked pattern. Skip generated/vendored files.` };
    }
  }

  return { blocked: false, reason: "" };
}

function getFileSummary(filePath: string, content: string): string {
  const lines = content.split("\n");
  const previewLines = lines.slice(0, 10).join("\n");
  return `[CACHED — already read this session] ${filePath} (${lines.length} lines)\n` +
    `Preview:\n${previewLines}\n...(${lines.length - 10} more lines)\n` +
    `→ You already read this file. Use the information you have. Do NOT re-read.`;
}

function isCached(filePath: string): boolean {
  const entry = fileReadCache.get(filePath);
  if (!entry) return false;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    fileReadCache.delete(filePath);
    return false;
  }
  return true;
}

function cacheFile(filePath: string, content: string): void {
  fileReadCache.set(filePath, {
    summary: getFileSummary(filePath, content),
    timestamp: Date.now(),
  });
}

export function resetContextGuardCache(): void {
  fileReadCache.clear();
}

export const contextGuardMiddleware = createMiddleware({
  name: "ContextGuardMiddleware",
  // @ts-expect-error - DeepAgents middleware typing
  wrapToolCall: async (
    request: { toolCall: { name: string; args: Record<string, unknown> } },
    handler: (req: unknown) => Promise<unknown>
  ) => {
    const { name: toolName, args } = request.toolCall;

    // Block directory listing on excluded directories
    if (toolName === "list_dir" || toolName === "ls" || toolName === "glob") {
      const targetPath = (args["path"] ?? args["directory"] ?? args["pattern"] ?? "") as string;
      const { blocked, reason } = isBlockedPath(targetPath);
      if (blocked) {
        return new ToolMessage({
          name: toolName,
          content: reason,
          tool_call_id: (request.toolCall as any).id || "unknown",
          status: "error",
        });
      }
    }

    // Block read_file on excluded paths
    if (toolName === "read_file") {
      const filePath = (args["file_path"] ?? args["path"] ?? "") as string;

      const { blocked, reason } = isBlockedPath(filePath);
      if (blocked) {
        return new ToolMessage({
          name: toolName,
          content: reason,
          tool_call_id: (request.toolCall as any).id || "unknown",
          status: "error",
        });
      }

      // Return cached summary for duplicate reads
      if (isCached(filePath)) {
        const cached = fileReadCache.get(filePath)!;
        return new ToolMessage({
          name: toolName,
          content: cached.summary,
          tool_call_id: (request.toolCall as any).id || "unknown",
        });
      }
    }

    // Auto-fix write_todos: LLMs sometimes stringify the array or use wrong status values
    if (toolName === "write_todos") {
      let todos = args["todos"];
      if (typeof todos === "string") {
        try { todos = JSON.parse(todos as string); } catch { /* let it fail */ }
      }
      if (Array.isArray(todos)) {
        const validStatuses = new Set(["pending", "in_progress", "completed"]);
        const fixTodos = (items: any[]): any[] => items.map((item: any) => {
          const fixed = { ...item };
          if (!validStatuses.has(fixed.status)) {
            fixed.status = "pending";
          }
          if (Array.isArray(fixed.todos)) {
            fixed.todos = fixTodos(fixed.todos);
          }
          return fixed;
        });
        request.toolCall.args = { ...args, todos: fixTodos(todos) };
      }
    }

    // Execute the actual tool call
    const result = normalizeToolResultContent(await handler(request)) as any;

    // Cache read_file results for deduplication
    if (toolName === "read_file" && result) {
      const filePath = (args["file_path"] ?? args["path"] ?? "") as string;
      const content = typeof result === "string"
        ? result
        : (result?.content ?? result?.update?.messages?.at?.(-1)?.content ?? result?.messages?.at?.(-1)?.content ?? "");
      if (typeof content === "string" && content.length > 0) {
        cacheFile(filePath, content);
      }
    }

    return result;

    // --- Post-write: auto tsc check for TypeScript files ---
    // Disabled for now — will enable after testing the basic middleware flow
  },
});

export async function runQuickTscCheck(filePath: string): Promise<string> {
  const normalized = filePath.replace(/\\/g, "/");
  if (!normalized.endsWith(".ts") && !normalized.endsWith(".tsx")) return "";

  try {
    await execFileAsync("npx", ["tsc", "--noEmit", "--pretty"], {
      timeout: 15000,
      maxBuffer: 512 * 1024,
    });
    return "";
  } catch (error: any) {
    const output = (error.stdout ?? "") + (error.stderr ?? "");
    const relevantErrors = output
      .split("\n")
      .filter((line: string) => line.includes("error TS"))
      .slice(0, 5)
      .join("\n");
    return relevantErrors ? `\n⚠️ TypeScript errors detected:\n${relevantErrors}` : "";
  }
}
