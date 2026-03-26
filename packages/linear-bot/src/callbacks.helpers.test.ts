import { describe, expect, it } from "vitest";
import { formatToolAction, formatToolResult, isValidToolCallPayload } from "./callbacks";

// ─── formatToolAction ────────────────────────────────────────────────────────

describe("formatToolAction", () => {
  it("edit_file with filepath", () => {
    expect(formatToolAction("edit_file", { filepath: "src/main.ts" })).toEqual({
      action: "Editing",
      parameter: "src/main.ts",
    });
  });

  it("write_file with path", () => {
    expect(formatToolAction("write_file", { path: "out/bundle.js" })).toEqual({
      action: "Editing",
      parameter: "out/bundle.js",
    });
  });

  it("edit_file falls back to 'file' when no filepath or path", () => {
    expect(formatToolAction("edit_file", {})).toEqual({
      action: "Editing",
      parameter: "file",
    });
  });

  it("read_file with filepath", () => {
    expect(formatToolAction("read_file", { filepath: "README.md" })).toEqual({
      action: "Reading",
      parameter: "README.md",
    });
  });

  it("read_file with path", () => {
    expect(formatToolAction("read_file", { path: "docs/guide.md" })).toEqual({
      action: "Reading",
      parameter: "docs/guide.md",
    });
  });

  it("read_file falls back to 'file' when no filepath or path", () => {
    expect(formatToolAction("read_file", {})).toEqual({
      action: "Reading",
      parameter: "file",
    });
  });

  it("bash with command", () => {
    expect(formatToolAction("bash", { command: "npm test" })).toEqual({
      action: "Running",
      parameter: "npm test",
    });
  });

  it("execute_command with cmd", () => {
    expect(formatToolAction("execute_command", { cmd: "ls -la" })).toEqual({
      action: "Running",
      parameter: "ls -la",
    });
  });

  it("bash with command >80 chars truncates to 77 + ...", () => {
    const longCmd = "a".repeat(100);
    expect(formatToolAction("bash", { command: longCmd })).toEqual({
      action: "Running",
      parameter: "a".repeat(77) + "...",
    });
  });

  it("bash with command exactly 80 chars is not truncated", () => {
    const cmd = "a".repeat(80);
    expect(formatToolAction("bash", { command: cmd })).toEqual({
      action: "Running",
      parameter: cmd,
    });
  });

  it("bash with no command renders empty", () => {
    expect(formatToolAction("bash", {})).toEqual({
      action: "Running",
      parameter: "",
    });
  });

  it("unknown tool uses tool name as action", () => {
    expect(formatToolAction("search_files", { query: "foo" })).toEqual({
      action: "search_files",
      parameter: "",
    });
  });
});

// ─── formatToolResult ────────────────────────────────────────────────────────

describe("formatToolResult", () => {
  it("converts action to past tense with result", () => {
    const result = formatToolResult("Edit", { filepath: "src/main.ts" }, "", false);
    expect(result.action).toBe("Edited");
    expect(result.parameter).toBe("src/main.ts");
    expect(result.result).toBe("✅");
  });

  it("shows error prefix on failure", () => {
    const result = formatToolResult("bash", { command: "npm test" }, "exit code 1", true);
    expect(result.action).toBe("Ran");
    expect(result.result).toContain("❌");
    expect(result.result).toContain("exit code 1");
  });

  it("truncates long results", () => {
    const longResult = "x".repeat(500);
    const result = formatToolResult("Read", {}, longResult, false);
    expect(result.result.length).toBeLessThanOrEqual(300);
  });
});

// ─── isValidToolCallPayload ──────────────────────────────────────────────────

describe("isValidToolCallPayload", () => {
  const valid = {
    sessionId: "sess-1",
    tool: "bash",
    args: { command: "ls" },
    callId: "call-1",
    timestamp: Date.now(),
    signature: "abc123",
    context: {
      issueId: "issue-1",
      issueIdentifier: "ENG-1",
    },
  };

  it("accepts a complete valid payload", () => {
    expect(isValidToolCallPayload(valid)).toBe(true);
  });

  it("rejects null", () => {
    expect(isValidToolCallPayload(null)).toBe(false);
  });

  it("rejects undefined", () => {
    expect(isValidToolCallPayload(undefined)).toBe(false);
  });

  it("rejects missing sessionId", () => {
    const { sessionId: _, ...rest } = valid;
    expect(isValidToolCallPayload(rest)).toBe(false);
  });

  it("rejects missing tool", () => {
    const { tool: _, ...rest } = valid;
    expect(isValidToolCallPayload(rest)).toBe(false);
  });

  it("rejects missing timestamp", () => {
    const { timestamp: _, ...rest } = valid;
    expect(isValidToolCallPayload(rest)).toBe(false);
  });

  it("rejects missing signature", () => {
    const { signature: _, ...rest } = valid;
    expect(isValidToolCallPayload(rest)).toBe(false);
  });

  it("rejects context: null", () => {
    expect(isValidToolCallPayload({ ...valid, context: null })).toBe(false);
  });

  it("rejects sessionId of wrong type", () => {
    expect(isValidToolCallPayload({ ...valid, sessionId: 123 })).toBe(false);
  });
});
