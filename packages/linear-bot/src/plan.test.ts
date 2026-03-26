import { describe, expect, it } from "vitest";
import { makePlan, newPlanProgress, updateProgress, progressToPlan } from "./plan";

const EXPECTED_CONTENT = [
  "Analyze issue & codebase",
  "Implement changes",
  "Run tests",
  "Open pull request",
];

describe("makePlan", () => {
  it("returns 4 steps with correct content labels", () => {
    const steps = makePlan("start");
    expect(steps).toHaveLength(4);
    expect(steps.map((s) => s.content)).toEqual(EXPECTED_CONTENT);
  });

  it("start → all pending", () => {
    const statuses = makePlan("start").map((s) => s.status);
    expect(statuses).toEqual(["pending", "pending", "pending", "pending"]);
  });

  it("repo_resolved → first inProgress, rest pending", () => {
    const statuses = makePlan("repo_resolved").map((s) => s.status);
    expect(statuses).toEqual(["inProgress", "pending", "pending", "pending"]);
  });

  it("session_created → first inProgress, rest pending", () => {
    const statuses = makePlan("session_created").map((s) => s.status);
    expect(statuses).toEqual(["inProgress", "pending", "pending", "pending"]);
  });

  it("completed → all completed", () => {
    const statuses = makePlan("completed").map((s) => s.status);
    expect(statuses).toEqual(["completed", "completed", "completed", "completed"]);
  });

  it("failed → first two completed, last two canceled", () => {
    const statuses = makePlan("failed").map((s) => s.status);
    expect(statuses).toEqual(["completed", "completed", "canceled", "canceled"]);
  });
});

describe("updateProgress", () => {
  it("marks analyze phase when reading files", () => {
    const progress = newPlanProgress();
    const changed = updateProgress(progress, "Read", { filepath: "src/main.ts" });
    expect(changed).toBe(true);
    expect(progress.phases.analyze).toBe("inProgress");
  });

  it("marks implement phase and completes analyze", () => {
    const progress = newPlanProgress();
    updateProgress(progress, "Read", {});
    const changed = updateProgress(progress, "Edit", { filepath: "src/main.ts" });
    expect(changed).toBe(true);
    expect(progress.phases.analyze).toBe("completed");
    expect(progress.phases.implement).toBe("inProgress");
  });

  it("marks test phase from bash npm test", () => {
    const progress = newPlanProgress();
    const changed = updateProgress(progress, "Bash", { command: "npm test" });
    expect(changed).toBe(true);
    expect(progress.phases.test).toBe("inProgress");
    expect(progress.phases.analyze).toBe("completed");
    expect(progress.phases.implement).toBe("completed");
  });

  it("marks PR phase from create-pull-request tool", () => {
    const progress = newPlanProgress();
    const changed = updateProgress(progress, "create-pull-request", { title: "Fix bug" });
    expect(changed).toBe(true);
    expect(progress.phases.pr).toBe("inProgress");
  });

  it("does not regress completed phases", () => {
    const progress = newPlanProgress();
    updateProgress(progress, "Edit", {});
    expect(progress.phases.analyze).toBe("completed");
    // Reading after editing shouldn't regress
    const changed = updateProgress(progress, "Read", {});
    expect(changed).toBe(false);
    expect(progress.phases.analyze).toBe("completed");
  });

  it("returns false for unknown tools", () => {
    const progress = newPlanProgress();
    const changed = updateProgress(progress, "unknown_tool", {});
    expect(changed).toBe(false);
  });
});

describe("progressToPlan", () => {
  it("converts progress to plan steps", () => {
    const progress = newPlanProgress();
    updateProgress(progress, "Edit", {});
    const plan = progressToPlan(progress);
    expect(plan).toHaveLength(4);
    expect(plan[0]).toEqual({ content: "Analyze issue & codebase", status: "completed" });
    expect(plan[1]).toEqual({ content: "Implement changes", status: "inProgress" });
    expect(plan[2]).toEqual({ content: "Run tests", status: "pending" });
    expect(plan[3]).toEqual({ content: "Open pull request", status: "pending" });
  });
});
