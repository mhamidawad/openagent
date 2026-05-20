import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { ErrorRecoverySystem } from "../agents/error-recovery.js";
import { PredictiveAnalyzer } from "../agents/predictive-analysis.js";

function formatRecovery(action: Awaited<ReturnType<ErrorRecoverySystem["handleError"]>>): string {
  const lines = [
    `Recovery classification: ${action.classification}`,
    `Strategy: ${action.strategy}`,
    `Confidence: ${Math.round(action.confidence * 100)}%`,
    `Reasoning: ${action.reasoning}`,
  ];

  if (action.delegateTo) {
    lines.push(`Delegate to: ${action.delegateTo}`);
  }

  lines.push("", "Recommended modifications:");
  for (const modification of action.modifications) {
    lines.push(`- ${modification}`);
  }

  if (action.relatedExperiences.length > 0) {
    lines.push("", "Related past experiences:");
    for (const experience of action.relatedExperiences) {
      lines.push(`- ${experience.id}: ${experience.errorPattern ?? "failure"} -> ${experience.resolution ?? "no recorded resolution"}`);
    }
  }

  lines.push("", `Tags: ${action.tags.join(", ")}`);
  return lines.join("\n");
}

function formatPredictions(issues: Awaited<ReturnType<PredictiveAnalyzer["analyzeBeforeExecution"]>>): string {
  if (issues.length === 0) {
    return "Predictive analysis found no obvious issues.";
  }

  const lines = [`Predictive analysis found ${issues.length} issue${issues.length === 1 ? "" : "s"}:`, ""];
  for (const issue of issues) {
    const location = issue.line ? ` line ${issue.line}` : "";
    lines.push(`[${issue.severity.toUpperCase()}] ${issue.category}${location}`);
    lines.push(`Problem: ${issue.message}`);
    lines.push(`Fix: ${issue.suggestion}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export function createIntelligenceTools(projectPath: string) {
  const recovery = new ErrorRecoverySystem();
  const analyzer = new PredictiveAnalyzer();

  return [
    tool(
      async (input: {
        errorMessage: string;
        command?: string;
        filePath?: string;
        agent?: string;
        taskContext?: string;
      }) => {
        const action = await recovery.handleError(input, projectPath);
        return formatRecovery(action);
      },
      {
        name: "analyze_error_recovery",
        description:
          "Classify a failure and recommend the next recovery action. Use after failed commands, failed tool calls, compiler errors, runtime errors, or blocked PM implementation attempts.",
        schema: z.object({
          errorMessage: z.string().describe("Full error output or failure message"),
          command: z.string().optional().describe("Command that failed, if any"),
          filePath: z.string().optional().describe("File involved in the failure, if any"),
          agent: z.string().optional().describe("Agent that encountered the failure"),
          taskContext: z.string().optional().describe("Short description of the current task"),
        }),
      },
    ),
    tool(
      async (input: {
        code: string;
        filePath?: string;
        language?: string;
      }) => {
        const issues = await analyzer.analyzeBeforeExecution({
          code: input.code,
          filePath: input.filePath,
          projectPath,
          language: input.language,
        });
        return formatPredictions(issues);
      },
      {
        name: "predict_code_issues",
        description:
          "Analyze code before writing or running it and flag likely runtime, compatibility, security, and maintainability issues. Use for risky files, auth, server code, generated code, or after revising a failed implementation.",
        schema: z.object({
          code: z.string().describe("Code text to analyze before writing or executing"),
          filePath: z.string().optional().describe("Intended file path, used for language and module-system checks"),
          language: z.string().optional().describe("Optional language hint"),
        }),
      },
    ),
  ];
}
