/**
 * Dynamic agent plan — updates based on tool call progression.
 *
 * The plan reflects what the agent is actually doing, derived from
 * tool calls received via callbacks. Steps are added dynamically
 * as new tool patterns are observed.
 */

export type PlanStepStatus = "pending" | "inProgress" | "completed" | "canceled";

export interface PlanStep {
  content: string;
  status: PlanStepStatus;
}

/** Ordered phases the agent typically goes through. */
const PHASES = [
  { id: "analyze", label: "Analyze issue & codebase", tools: ["Read", "read_file", "Glob", "Grep", "Bash:grep", "Bash:find", "Bash:ls", "Bash:cat"] },
  { id: "implement", label: "Implement changes", tools: ["Edit", "edit_file", "Write", "write_file"] },
  { id: "test", label: "Run tests", tools: ["Bash:npm test", "Bash:npx vitest", "Bash:pnpm test", "Bash:pytest", "Bash:jest"] },
  { id: "pr", label: "Open pull request", tools: ["create-pull-request", "Bash:gh pr", "Bash:git push"] },
] as const;

type PhaseId = typeof PHASES[number]["id"];

/** Tracks which phases have been entered. Stored in KV alongside session data. */
export interface PlanProgress {
  phases: Record<string, "pending" | "inProgress" | "completed">;
  customSteps: string[];
}

export function newPlanProgress(): PlanProgress {
  const phases: Record<string, "pending" | "inProgress" | "completed"> = {};
  for (const phase of PHASES) {
    phases[phase.id] = "pending";
  }
  return { phases, customSteps: [] };
}

/** Determine which phase a tool call belongs to. */
function matchPhase(tool: string, args: Record<string, unknown>): PhaseId | null {
  const command = String(args.command || args.cmd || "");

  for (const phase of PHASES) {
    for (const pattern of phase.tools) {
      if (pattern.startsWith("Bash:")) {
        const bashPattern = pattern.slice(5);
        if ((tool === "Bash" || tool === "bash" || tool === "execute_command") && command.includes(bashPattern)) {
          return phase.id;
        }
      } else if (tool === pattern || tool.toLowerCase() === pattern.toLowerCase()) {
        return phase.id;
      }
    }
  }
  return null;
}

/** Update progress based on a tool call. Returns true if progress changed. */
export function updateProgress(progress: PlanProgress, tool: string, args: Record<string, unknown>): boolean {
  const phaseId = matchPhase(tool, args);
  if (!phaseId) return false;

  const current = progress.phases[phaseId];
  if (current === "completed" || current === "inProgress") {
    // If we're already past this phase but come back (e.g. reading after editing), don't regress
    return false;
  }

  // Mark this phase as inProgress, and complete all earlier phases
  let changed = false;
  let foundCurrent = false;
  for (const phase of PHASES) {
    if (phase.id === phaseId) {
      foundCurrent = true;
      if (progress.phases[phase.id] !== "inProgress") {
        progress.phases[phase.id] = "inProgress";
        changed = true;
      }
    } else if (!foundCurrent && progress.phases[phase.id] !== "completed") {
      progress.phases[phase.id] = "completed";
      changed = true;
    }
  }
  return changed;
}

/** Convert progress to Linear plan steps. */
export function progressToPlan(progress: PlanProgress): PlanStep[] {
  return PHASES.map((phase) => ({
    content: phase.label,
    status: (progress.phases[phase.id] || "pending") as PlanStepStatus,
  }));
}

/** Static plan for initial stages (before tool callbacks start). */
export function makePlan(
  stage: "start" | "repo_resolved" | "session_created" | "completed" | "failed"
): PlanStep[] {
  const steps = PHASES.map((p) => p.label);
  const statusMap: Record<string, PlanStepStatus[]> = {
    start: ["pending", "pending", "pending", "pending"],
    repo_resolved: ["inProgress", "pending", "pending", "pending"],
    session_created: ["inProgress", "pending", "pending", "pending"],
    completed: ["completed", "completed", "completed", "completed"],
    failed: ["completed", "completed", "canceled", "canceled"],
  };
  const statuses = statusMap[stage];
  return steps.map((content, i) => ({ content, status: statuses[i] }));
}
