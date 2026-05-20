import { queryExperiences } from "../memory/experience-replay.js";

export type RecoveryStrategy = "retry" | "delegate" | "decompose" | "escalate";

export interface AgentErrorInput {
  errorMessage: string;
  command?: string;
  filePath?: string;
  agent?: string;
  taskContext?: string;
}

export interface RecoveryAction {
  classification: string;
  strategy: RecoveryStrategy;
  confidence: number;
  reasoning: string;
  modifications: string[];
  delegateTo?: string;
  tags: string[];
  relatedExperiences: Array<{
    id: string;
    outcome: string;
    errorPattern?: string;
    resolution?: string;
  }>;
}

const ERROR_RULES: Array<{
  name: string;
  pattern: RegExp;
  strategy: RecoveryStrategy;
  confidence: number;
  tags: string[];
  delegateTo?: string;
  modifications: string[];
  reasoning: string;
}> = [
  {
    name: "node-esm-require",
    pattern: /require is not defined in ES module scope|type["']?\s*:\s*["']module/i,
    strategy: "retry",
    confidence: 0.95,
    tags: ["node", "esm", "module-system"],
    delegateTo: "backend-lead",
    modifications: [
      "If the file intentionally uses CommonJS, rename it to .cjs.",
      "Otherwise convert require/module.exports to ESM import/export syntax.",
      "Check package.json type before choosing .js, .mjs, or .cjs.",
    ],
    reasoning: "Node is running the file as an ES module, so CommonJS require is unavailable.",
  },
  {
    name: "module-not-found",
    pattern: /ERR_MODULE_NOT_FOUND|Cannot find module|Module not found|TS2307/i,
    strategy: "retry",
    confidence: 0.86,
    tags: ["import-error", "dependency"],
    modifications: [
      "Verify the import path and extension.",
      "Prefer existing project dependencies before adding new packages.",
      "If the dependency is missing and allowed, install it; otherwise rewrite using available APIs.",
    ],
    reasoning: "The runtime or compiler could not resolve an import.",
  },
  {
    name: "typescript-type-error",
    pattern: /error TS\d+|Type '.*' is not assignable|Property .* does not exist/i,
    strategy: "retry",
    confidence: 0.82,
    tags: ["typescript", "type-error"],
    modifications: [
      "Read the referenced type/interface before editing.",
      "Fix the source type mismatch instead of using any or broad assertions.",
      "Run the smallest available TypeScript check after the fix.",
    ],
    reasoning: "The compiler found a type contract mismatch.",
  },
  {
    name: "syntax-error",
    pattern: /SyntaxError|Unexpected token|Unexpected end of input|missing \)|unterminated/i,
    strategy: "retry",
    confidence: 0.82,
    tags: ["syntax"],
    modifications: [
      "Inspect the exact line and nearby delimiters.",
      "Check braces, parentheses, quotes, template strings, and trailing commas.",
      "Use a parser/compiler check before continuing.",
    ],
    reasoning: "The code could not be parsed.",
  },
  {
    name: "address-in-use",
    pattern: /EADDRINUSE|address already in use/i,
    strategy: "retry",
    confidence: 0.9,
    tags: ["server", "port"],
    modifications: [
      "Use a different port or stop the existing process.",
      "Make the port configurable through an environment variable.",
    ],
    reasoning: "The configured server port is already occupied.",
  },
  {
    name: "permission-denied",
    pattern: /EACCES|EPERM|permission denied|access is denied/i,
    strategy: "escalate",
    confidence: 0.84,
    tags: ["permissions", "filesystem"],
    modifications: [
      "Verify the target path is inside the project workspace.",
      "Ask for approval if elevated filesystem access is truly required.",
      "Avoid writing to protected system directories.",
    ],
    reasoning: "The operation needs permissions that are not currently available.",
  },
  {
    name: "timeout",
    pattern: /timed out|timeout|ETIMEDOUT|exceeded.*time/i,
    strategy: "decompose",
    confidence: 0.78,
    tags: ["timeout", "performance"],
    modifications: [
      "Break the task into smaller steps.",
      "Reduce scan/build scope and retry.",
      "Use cached project context or targeted code_search before broad scans.",
    ],
    reasoning: "The operation exceeded its time budget.",
  },
  {
    name: "schema-validation",
    pattern: /ZodError|schema validation|Invalid enum value|Expected .* received|invalid_type/i,
    strategy: "retry",
    confidence: 0.88,
    tags: ["tool-schema", "validation"],
    modifications: [
      "Read the tool schema and retry with the allowed values.",
      "Remove extra keys that are not accepted by the schema.",
      "Use the exact enum values from the error message.",
    ],
    reasoning: "A tool call or payload did not match the expected schema.",
  },
  {
    name: "pm-implementation-blocked",
    pattern: /PM Agent cannot write implementation files|PM Agent cannot run shell commands|delegate this implementation/i,
    strategy: "delegate",
    confidence: 0.96,
    tags: ["delegation", "pm-guard"],
    modifications: [
      "Create or update Markdown context only.",
      "Delegate implementation to the responsible lead agent with task().",
      "Include target folder, file list, constraints, and verification command in the delegation.",
    ],
    reasoning: "PM is coordinator-only and attempted implementation work.",
  },
  {
    name: "file-not-found",
    pattern: /ENOENT|no such file or directory|cannot find the path/i,
    strategy: "retry",
    confidence: 0.78,
    tags: ["filesystem", "missing-file"],
    modifications: [
      "Verify the path and working directory.",
      "Create the parent directory before writing the file.",
      "Use project-relative paths when possible.",
    ],
    reasoning: "The referenced file or directory does not exist.",
  },
];

function inferDelegate(input: AgentErrorInput, fallback?: string): string | undefined {
  if (fallback) return fallback;
  const combined = `${input.filePath ?? ""} ${input.command ?? ""} ${input.taskContext ?? ""}`.toLowerCase();
  if (combined.includes("frontend") || combined.includes(".html") || combined.includes(".css") || combined.includes(".tsx")) return "frontend-lead";
  if (combined.includes("test") || combined.includes("spec") || combined.includes("playwright") || combined.includes("jest")) return "qa-lead";
  if (combined.includes("docker") || combined.includes("deploy") || combined.includes("ci")) return "deploy-lead";
  if (combined.includes("security") || combined.includes("auth")) return "security-lead";
  if (combined.includes("api") || combined.includes("server") || combined.includes(".js") || combined.includes(".cjs") || combined.includes(".ts")) return "backend-lead";
  return undefined;
}

export class ErrorRecoverySystem {
  async handleError(input: AgentErrorInput, projectPath?: string): Promise<RecoveryAction> {
    const text = [
      input.errorMessage,
      input.command ?? "",
      input.filePath ?? "",
      input.taskContext ?? "",
    ].join("\n");

    const matched = ERROR_RULES.find((rule) => rule.pattern.test(text));
    const fallback = {
      name: "unknown-error",
      strategy: "escalate" as const,
      confidence: 0.45,
      tags: ["unknown-error"],
      modifications: [
        "Capture the exact command, file path, and full error output.",
        "Search past experiences for similar failures.",
        "Ask for targeted human guidance if the next step is ambiguous.",
      ],
      reasoning: "No deterministic recovery rule matched this error.",
    };

    const rule = matched ?? fallback;
    const relatedExperiences = projectPath
      ? await queryExperiences(projectPath, { outcome: "failure", tags: rule.tags })
      : [];

    return {
      classification: rule.name,
      strategy: rule.strategy,
      confidence: rule.confidence,
      reasoning: rule.reasoning,
      modifications: rule.modifications,
      delegateTo: inferDelegate(input, "delegateTo" in rule ? rule.delegateTo : undefined),
      tags: rule.tags,
      relatedExperiences: relatedExperiences.slice(-3).map((experience) => ({
        id: experience.id,
        outcome: experience.outcome,
        errorPattern: experience.errorPattern,
        resolution: experience.resolution,
      })),
    };
  }
}
