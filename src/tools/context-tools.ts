import { tool } from "@langchain/core/tools";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import { intelligentCache, makeCacheKey, projectCacheTag } from "../cache/intelligent-cache.js";

const IGNORED_DIRS = new Set([
  "node_modules", "dist", "build", "coverage", ".git",
  ".next", ".nuxt", "__pycache__", ".cache", ".turbo",
]);

async function getTree(root: string, depth = 3): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string, d: number): Promise<void> {
    if (d <= 0) return;
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue;
        const rel = path.relative(root, path.join(dir, entry.name));
        if (entry.isDirectory()) {
          results.push(rel + "/");
          await walk(path.join(dir, entry.name), d - 1);
        } else {
          results.push(rel);
        }
      }
    } catch { /* skip */ }
  }

  await walk(root, depth);
  return results;
}

function detectStack(deps: Record<string, string>): string[] {
  const stack: string[] = [];
  const checks: [string, string][] = [
    ["react", "React"], ["vue", "Vue"], ["angular", "Angular"],
    ["next", "Next.js"], ["nuxt", "Nuxt"], ["svelte", "Svelte"],
    ["express", "Express"], ["fastify", "Fastify"], ["@nestjs/core", "NestJS"],
    ["hono", "Hono"], ["koa", "Koa"],
    ["typescript", "TypeScript"], ["tailwindcss", "Tailwind CSS"],
    ["prisma", "Prisma"], ["typeorm", "TypeORM"], ["drizzle-orm", "Drizzle"],
    ["mongoose", "Mongoose"], ["pg", "PostgreSQL"], ["mysql2", "MySQL"],
    ["redis", "Redis"], ["ioredis", "Redis"],
    ["jest", "Jest"], ["vitest", "Vitest"], ["mocha", "Mocha"],
  ];
  for (const [dep, label] of checks) {
    if (deps[dep]) stack.push(label);
  }
  return stack;
}

export function createCollectProjectContextTool(projectPath: string) {
  intelligentCache.watchProject(projectPath);

  return tool(
    async () => {
      const cacheKey = makeCacheKey(["project-context", path.resolve(projectPath).toLowerCase()]);

      return intelligentCache.getOrSet(
        cacheKey,
        async () => {
          let pkg: any = null;
          try {
            pkg = JSON.parse(await fs.readFile(path.join(projectPath, "package.json"), "utf-8"));
          } catch { /* none */ }

          let readme = "";
          for (const name of ["README.md", "README.MD", "readme.md"]) {
            try {
              readme = (await fs.readFile(path.join(projectPath, name), "utf-8")).slice(0, 500);
              break;
            } catch { /* try next */ }
          }

          let sajicodeMd = "";
          try {
            sajicodeMd = await fs.readFile(path.join(projectPath, "SAJICODE.md"), "utf-8");
          } catch { /* none */ }

          let whatsDone = "";
          try {
            whatsDone = await fs.readFile(path.join(projectPath, ".sajicode", "whats_done.md"), "utf-8");
          } catch { /* none */ }

          const memories: Record<string, string> = {};
          try {
            const memDir = path.join(projectPath, ".sajicode", "memories");
            const files = await fs.readdir(memDir);
            for (const f of files.filter((f) => f.endsWith(".md"))) {
              memories[f] = await fs.readFile(path.join(memDir, f), "utf-8");
            }
          } catch { /* none */ }

          const tree = await getTree(projectPath);
          const allDeps = pkg ? { ...pkg.dependencies, ...pkg.devDependencies } : {};
          const stack = detectStack(allDeps);

          if (tree.some((f) => f.endsWith(".ts") || f.endsWith(".tsx")) && !stack.includes("TypeScript")) stack.push("TypeScript");
          if (tree.some((f) => f.endsWith(".py"))) stack.push("Python");
          if (tree.some((f) => f.endsWith(".go"))) stack.push("Go");

          return JSON.stringify({
            projectPath,
            techStack: stack,
            package: pkg ? {
              name: pkg.name, version: pkg.version,
              scripts: pkg.scripts,
              dependencies: Object.keys(pkg.dependencies ?? {}),
              devDependencies: Object.keys(pkg.devDependencies ?? {}),
            } : null,
            structure: tree.slice(0, 80).join("\n"),
            totalFiles: tree.length,
            readme: readme || null,
            sajicodeMd: sajicodeMd || null,
            whatsDone: whatsDone || null,
            memories,
          }, null, 2);
        },
        {
          ttlMs: 5 * 60 * 1000,
          tags: [projectCacheTag(projectPath)],
        },
      );
    },
    {
      name: "collect_project_context",
      description: "Get FULL project context in ONE call: tech stack, structure, dependencies, README, SAJICODE.md, memories, and previous work. Call this FIRST.",
      schema: z.object({}),
    }
  );
}

export function createUpdateProjectContextTool(projectPath: string) {
  return tool(
    async (input: { section: string; content: string }) => {
      const filePath = path.join(projectPath, "SAJICODE.md");

      try {
        let existing = "";
        try {
          existing = await fs.readFile(filePath, "utf-8");
        } catch {
          existing = "# Project Context\n\n";
        }

        const header = `## ${input.section}`;
        const regex = new RegExp(`## ${input.section}[\\s\\S]*?(?=\\n## |$)`, "g");
        const block = `${header}\n${input.content}\n\n`;

        existing = existing.includes(header)
          ? existing.replace(regex, block)
          : existing + block;

        const stamp = `\n---\n*Updated: ${new Date().toISOString()}*\n`;
        existing = existing.replace(/\n---\n\*Updated:.*\*\n?/g, "").trimEnd() + stamp;

        await fs.writeFile(filePath, existing, "utf-8");
        return `Updated SAJICODE.md section: "${input.section}"`;
      } catch (error) {
        return `Failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    {
      name: "update_project_context",
      description: "Update a section in SAJICODE.md. Call when making major project changes.",
      schema: z.object({
        section: z.string().describe("Section title (e.g. 'Progress', 'Architecture')"),
        content: z.string().describe("Markdown content for the section"),
      }),
    }
  );
}

export function createSaveMemoryTool(projectPath: string) {
  return tool(
    async (input: { key: string; content: string }) => {
      const memDir = path.join(projectPath, ".sajicode", "memories");
      await fs.mkdir(memDir, { recursive: true });

      const filename = input.key.replace(/[^a-z0-9_-]/gi, "_").toLowerCase() + ".md";
      const filePath = path.join(memDir, filename);

      let existing = "";
      try {
        existing = await fs.readFile(filePath, "utf-8");
      } catch { /* new file */ }

      const timestamp = new Date().toISOString();
      const entry = existing
        ? `${existing.trimEnd()}\n\n---\n[${timestamp}]\n${input.content}`
        : `# ${input.key}\n\n[${timestamp}]\n${input.content}`;

      await fs.writeFile(filePath, entry, "utf-8");
      return `Saved memory: "${input.key}" → .sajicode/memories/${filename}`;
    },
    {
      name: "save_memory",
      description: "Save important information to long-term memory. Persists across sessions. Use for: user preferences, decisions, instructions, or anything the user says to remember.",
      schema: z.object({
        key: z.string().describe("Memory category (e.g. 'user_info', 'preferences', 'decisions')"),
        content: z.string().describe("What to remember"),
      }),
    }
  );
}

export function createUpdateAgentMemoryTool(projectPath: string, agentName: string) {
  return tool(
    async (input: {
      what_was_done: string;
      files_created: Array<{ path: string; description: string }>;
      files_modified: Array<{ path: string; change: string }>;
      contracts?: string[];
      blockers?: string[];
    }) => {
      const { appendAgentMemory } = await import("../memory/agent-memory.js");

      const filesSummary = [
        ...input.files_created.map((f) => `Created: ${f.path} — ${f.description}`),
        ...input.files_modified.map((f) => `Modified: ${f.path} — ${f.change}`),
      ].join("; ");

      await appendAgentMemory(
        projectPath,
        agentName,
        "progress",
        `${input.what_was_done}. Files: ${filesSummary}`,
        input.files_created.map((f) => f.path),
      );

      if (input.contracts?.length) {
        for (const contract of input.contracts) {
          await appendAgentMemory(projectPath, agentName, "contract", contract, ["api", "interface"]);
        }
      }

      if (input.blockers?.length) {
        for (const blocker of input.blockers) {
          await appendAgentMemory(projectPath, agentName, "blocker", blocker, ["issue"]);
        }
      }

      return `Memory updated for ${agentName} .`;
    },
    {
      name: "update_agent_memory",
      description:
        "REQUIRED after completing any task: save what you built to your permanent memory. This persists across sessions so you never forget your own work.",
      schema: z.object({
        what_was_done: z.string().describe("One-sentence summary of what was completed"),
        files_created: z
          .array(z.object({ path: z.string(), description: z.string() }))
          .describe("Every file you created with a one-line description of its purpose"),
        files_modified: z
          .array(z.object({ path: z.string(), change: z.string() }))
          .describe("Every file you modified and what you changed"),
        contracts: z
          .array(z.string())
          .optional()
          .describe(
            "API shapes, shared types, env vars or interfaces other agents depend on (e.g. 'POST /api/auth/login returns { token: string }')"
          ),
        blockers: z
          .array(z.string())
          .optional()
          .describe("Any known issues or incomplete work"),
      }),
    }
  );
}

export function createUpdateProjectLogTool(projectPath: string) {
  return tool(
    async (input: {
      agent_name: string;
      status: "complete" | "in_progress" | "blocked" | "failed";
      what_was_done: string;
      files_created: Array<{ path: string; description: string }>;
      files_modified: Array<{ path: string; change: string }>;
      cross_agent_contracts?: string[];
      what_still_needs_doing?: string[];
    }) => {
      const logPath = path.join(projectPath, ".sajicode", "whats_done.md");
      await fs.mkdir(path.dirname(logPath), { recursive: true });

      const statusEmoji = { complete: "✅", in_progress: "🔄", blocked: "🚧", failed: "❌" }[
        input.status
      ];
      const timestamp = new Date().toISOString();

      const filesCreatedSection =
        input.files_created.length > 0
          ? `### Files Created\n${input.files_created.map((f) => `- \`${f.path}\` — ${f.description}`).join("\n")}`
          : "";
      const filesModifiedSection =
        input.files_modified.length > 0
          ? `### Files Modified\n${input.files_modified.map((f) => `- \`${f.path}\` — ${f.change}`).join("\n")}`
          : "";
      const contractsSection = input.cross_agent_contracts?.length
        ? `### Cross-Agent Contracts\n${input.cross_agent_contracts.map((c) => `- ${c}`).join("\n")}`
        : "";
      const todoSection = input.what_still_needs_doing?.length
        ? `### Still Needs Doing\n${input.what_still_needs_doing.map((t) => `- ${t}`).join("\n")}`
        : "";

      const entry = [
        `\n---\n## [${timestamp}] ${input.agent_name}`,
        `**Status**: ${statusEmoji} ${input.status}`,
        `**Summary**: ${input.what_was_done}`,
        filesCreatedSection,
        filesModifiedSection,
        contractsSection,
        todoSection,
      ].filter(Boolean).join("\n") + "\n";

      // Append-only — never overwrite previous entries
      let existing = "";
      try {
        existing = await fs.readFile(logPath, "utf-8");
      } catch {
        existing = `# Project Log\n*This file is append-only. Every agent update is recorded here permanently.*\n`;
      }

      await fs.writeFile(logPath, existing.trimEnd() + entry, "utf-8");
      return `Project log updated by ${input.agent_name} — status: ${input.status}`;
    },
    {
      name: "update_project_log",
      description:
        "REQUIRED: Call this after completing any meaningful work. Updates the permanent project log that ALL agents and future sessions read. This is how the team knows what was built.",
      schema: z.object({
        agent_name: z
          .string()
          .describe("Your agent name (e.g. 'backend-lead', 'pm-agent')"),
        status: z
          .enum(["complete", "in_progress", "blocked", "failed"])
          .describe("Current status of the work"),
        what_was_done: z
          .string()
          .describe("One-sentence summary of what was completed or attempted"),
        files_created: z
          .array(z.object({ path: z.string(), description: z.string() }))
          .describe("Every file created, with path and one-line purpose description"),
        files_modified: z
          .array(z.object({ path: z.string(), change: z.string() }))
          .describe("Every file modified and what changed"),
        cross_agent_contracts: z
          .array(z.string())
          .optional()
          .describe(
            "API shapes, types, env vars other agents must know (e.g. 'GET /api/expenses returns Expense[]')"
          ),
        what_still_needs_doing: z
          .array(z.string())
          .optional()
          .describe("Incomplete work or follow-up tasks"),
      }),
    }
  );
}

export function createContextTools(projectPath: string) {
  return [
    createCollectProjectContextTool(projectPath),
    createUpdateProjectContextTool(projectPath),
    createSaveMemoryTool(projectPath),
    createUpdateProjectLogTool(projectPath),
  ];
}

export const collectProjectContextTool = createCollectProjectContextTool(process.cwd());
