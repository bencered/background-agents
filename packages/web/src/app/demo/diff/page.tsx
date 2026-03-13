"use client";

import { useState, useMemo, useCallback } from "react";
import { MultiFileDiff, PatchDiff, type FileContents } from "@pierre/diffs/react";

// --- Sample data -----------------------------------------------------------

const SAMPLE_OLD: FileContents = {
  name: "src/session/sandbox-events.ts",
  contents: `import { generateId } from "../auth/crypto";
import type { Logger } from "../logger";
import type { SandboxEvent, ServerMessage } from "../types";
import { shouldPersistToolCallEvent } from "./event-persistence";
import type { SessionRepository } from "./repository";

export class SessionSandboxEventProcessor {
  constructor(private readonly deps: SessionSandboxEventProcessorDeps) {}

  async processSandboxEvent(event: SandboxEvent): Promise<void> {
    if (event.type === "heartbeat") {
      this.deps.repository.updateSandboxHeartbeat(Date.now());
      return;
    }

    if (event.type === "token") {
      this.deps.broadcast({ type: "sandbox_event", event });
      return;
    }

    if (event.type === "execution_complete") {
      this.deps.broadcast({ type: "sandbox_event", event });
      await this.deps.reconcileSessionStatusAfterExecution(event.success);
      return;
    }

    this.deps.repository.createEvent({
      id: generateId(),
      type: event.type,
      data: JSON.stringify(event),
      messageId: null,
      createdAt: Date.now(),
    });

    this.deps.broadcast({ type: "sandbox_event", event });
  }
}
`,
};

const SAMPLE_NEW: FileContents = {
  name: "src/session/sandbox-events.ts",
  contents: `import { generateId } from "../auth/crypto";
import type { Logger } from "../logger";
import type { SandboxEvent, ServerMessage } from "../types";
import { shouldPersistToolCallEvent } from "./event-persistence";
import type { SessionRepository } from "./repository";
import type { DiffSnapshotService } from "./diff-snapshot-service";

export class SessionSandboxEventProcessor {
  private diffDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: SessionSandboxEventProcessorDeps) {}

  async processSandboxEvent(event: SandboxEvent): Promise<void> {
    if (event.type === "heartbeat") {
      this.deps.repository.updateSandboxHeartbeat(Date.now());
      return;
    }

    if (event.type === "token") {
      this.deps.broadcast({ type: "sandbox_event", event });
      return;
    }

    if (event.type === "tool_call" && event.status === "completed") {
      this.deps.broadcast({ type: "sandbox_event", event });
      this.scheduleDiffSnapshot();
      return;
    }

    if (event.type === "execution_complete") {
      this.deps.broadcast({ type: "sandbox_event", event });
      await this.deps.reconcileSessionStatusAfterExecution(event.success);
      // Always capture final diff snapshot
      await this.deps.diffService.captureSnapshot();
      return;
    }

    this.deps.repository.createEvent({
      id: generateId(),
      type: event.type,
      data: JSON.stringify(event),
      messageId: null,
      createdAt: Date.now(),
    });

    this.deps.broadcast({ type: "sandbox_event", event });
  }

  private scheduleDiffSnapshot(): void {
    if (this.diffDebounceTimer) {
      clearTimeout(this.diffDebounceTimer);
    }
    this.diffDebounceTimer = setTimeout(async () => {
      await this.deps.diffService.captureSnapshot();
      this.diffDebounceTimer = null;
    }, 500);
  }
}
`,
};

const SAMPLE_PATCH = `diff --git a/src/sandbox/bridge.py b/src/sandbox/bridge.py
index 3a1b2c4..8f9d0e1 100644
--- a/src/sandbox/bridge.py
+++ b/src/sandbox/bridge.py
@@ -527,6 +527,8 @@ class SandboxBridge:
         elif cmd_type == "push":
             await self._handle_push(cmd)
+        elif cmd_type == "compact":
+            await self._handle_compact()
         elif cmd_type == "ack":
             ack_id = cmd.get("ackId")
             if ack_id and ack_id in self._pending_acks:
@@ -590,6 +592,22 @@ class SandboxBridge:
             self.log.debug("bridge.unknown_command", cmd_type=cmd_type)
         return None
 
+    async def _handle_compact(self) -> None:
+        """Trigger manual compaction of the OpenCode session."""
+        if not self.opencode_session_id:
+            self.log.warn("compact.no_session")
+            return
+
+        old_id = self.opencode_session_id
+        resp = await self.http_client.post(
+            f"{self.opencode_base_url}/session/{self.opencode_session_id}/summarize",
+            timeout=30,
+        )
+        resp.raise_for_status()
+        data = resp.json()
+
+        new_session_id = data.get("id")
+        if new_session_id and new_session_id != old_id:
+            self.opencode_session_id = new_session_id
+            await self._save_session_id()
+            self.log.info("bridge.manual_compact", old_id=old_id, new_id=new_session_id)
+
+        await self._send_event({"type": "session_compacted"})
+
     async def _handle_prompt(self, cmd: dict) -> None:
         """Handle prompt command - send to OpenCode and stream response."""
diff --git a/src/lib/files.ts b/src/lib/files.ts
index 1a2b3c4..5e6f7a8 100644
--- a/src/lib/files.ts
+++ b/src/lib/files.ts
@@ -1,5 +1,6 @@
 import { diffLines } from "diff";
 import type { FileChange, SandboxEvent } from "@/types/session";
+import type { DiffSnapshot } from "@/types/diff";
 
 /**
  * Count the number of lines in a string.
@@ -95,3 +96,15 @@ export function extractChangedFiles(events: SandboxEvent[]): FileChange[] {
 
   return Array.from(fileMap.values()).sort((a, b) => a.filename.localeCompare(b.filename));
 }
+
+/**
+ * Parse a unified diff string into per-file patches for the diff viewer.
+ */
+export function parseDiffSnapshot(raw: string): DiffSnapshot {
+  const files = raw.split(/^diff --git/m).filter(Boolean);
+  return {
+    files: files.map(f => {
+      const nameMatch = f.match(/^\\s+a\\/(.+?)\\s+b\\//);
+      return { path: nameMatch?.[1] ?? "unknown", patch: "diff --git" + f };
+    }),
+  };
+}`;

// --- Comment types ---------------------------------------------------------

interface DiffComment {
  id: string;
  file: string;
  line: number;
  side: "deletions" | "additions";
  author: string;
  text: string;
  createdAt: number;
}

// --- Page component --------------------------------------------------------

export default function DiffDemoPage() {
  const [mode, setMode] = useState<"files" | "patch">("files");
  const [diffStyle, setDiffStyle] = useState<"split" | "unified">("split");
  const [comments, setComments] = useState<DiffComment[]>([
    {
      id: "1",
      file: "src/session/sandbox-events.ts",
      line: 10,
      side: "additions",
      author: "Bence",
      text: "Should we make the debounce interval configurable?",
      createdAt: Date.now() - 60000,
    },
    {
      id: "2",
      file: "src/session/sandbox-events.ts",
      line: 37,
      side: "additions",
      author: "Cole",
      text: "Nice — capturing on execution_complete is important for the final state.",
      createdAt: Date.now() - 30000,
    },
  ]);
  const [commentInput, setCommentInput] = useState<{
    line: number;
    side: "deletions" | "additions";
  } | null>(null);
  const [commentText, setCommentText] = useState("");

  const addComment = useCallback(
    (line: number, side: "deletions" | "additions") => {
      if (!commentText.trim()) return;
      setComments((prev) => [
        ...prev,
        {
          id: String(Date.now()),
          file: "src/session/sandbox-events.ts",
          line,
          side,
          author: "You",
          text: commentText.trim(),
          createdAt: Date.now(),
        },
      ]);
      setCommentText("");
      setCommentInput(null);
    },
    [commentText]
  );

  const lineAnnotations = useMemo(
    () =>
      comments.map((c) => ({
        lineNumber: c.line,
        side: c.side,
        metadata: c,
      })),
    [comments]
  );

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0a0a0b",
        color: "#e0e0e0",
        fontFamily: "var(--font-geist-sans), system-ui, sans-serif",
      }}
    >
      {/* Header */}
      <div
        style={{
          borderBottom: "1px solid #1e1e24",
          padding: "16px 24px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h1
            style={{
              fontSize: 16,
              fontWeight: 600,
              margin: 0,
              color: "#fff",
            }}
          >
            Diff View Demo
          </h1>
          <span
            style={{
              fontSize: 12,
              padding: "2px 8px",
              background: "#1e1e24",
              borderRadius: 4,
              color: "#888",
            }}
          >
            powered by diffs.com
          </span>
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          {/* Mode toggle */}
          <div
            style={{
              display: "flex",
              background: "#1e1e24",
              borderRadius: 6,
              padding: 2,
            }}
          >
            {(["files", "patch"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                style={{
                  padding: "4px 12px",
                  fontSize: 13,
                  border: "none",
                  borderRadius: 4,
                  cursor: "pointer",
                  background: mode === m ? "#2a2a32" : "transparent",
                  color: mode === m ? "#fff" : "#888",
                  transition: "all 0.15s",
                }}
              >
                {m === "files" ? "Two Files" : "Patch"}
              </button>
            ))}
          </div>

          {/* Style toggle */}
          <div
            style={{
              display: "flex",
              background: "#1e1e24",
              borderRadius: 6,
              padding: 2,
            }}
          >
            {(["split", "unified"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setDiffStyle(s)}
                style={{
                  padding: "4px 12px",
                  fontSize: 13,
                  border: "none",
                  borderRadius: 4,
                  cursor: "pointer",
                  background: diffStyle === s ? "#2a2a32" : "transparent",
                  color: diffStyle === s ? "#fff" : "#888",
                  transition: "all 0.15s",
                }}
              >
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Diff stats bar */}
      <div
        style={{
          padding: "12px 24px",
          borderBottom: "1px solid #1e1e24",
          display: "flex",
          alignItems: "center",
          gap: 16,
          fontSize: 13,
          color: "#888",
        }}
      >
        <span>{mode === "files" ? "1 file changed" : "2 files changed"}</span>
        <span style={{ color: "#3d9e74" }}>+{mode === "files" ? "18" : "32"} additions</span>
        <span style={{ color: "#c24f32" }}>-{mode === "files" ? "4" : "2"} deletions</span>
        <span style={{ marginLeft: "auto", fontSize: 12 }}>
          💬 {comments.length} comment{comments.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Diff content */}
      <div style={{ padding: "0 24px 48px" }}>
        {mode === "files" ? (
          <MultiFileDiff
            oldFile={SAMPLE_OLD}
            newFile={SAMPLE_NEW}
            options={{
              theme: "pierre-dark",
              diffStyle,
            }}
            lineAnnotations={lineAnnotations}
            renderAnnotation={(annotation) => {
              const comment = annotation.metadata;
              return (
                <div
                  style={{
                    padding: "8px 12px",
                    margin: "4px 0",
                    background: "#16161d",
                    borderLeft: "3px solid #3b82f6",
                    borderRadius: "0 4px 4px 0",
                    fontSize: 13,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      gap: 8,
                      marginBottom: 4,
                      alignItems: "center",
                    }}
                  >
                    <span style={{ fontWeight: 600, color: "#e0e0e0" }}>{comment.author}</span>
                    <span style={{ fontSize: 11, color: "#555" }}>
                      {new Date(comment.createdAt).toLocaleTimeString()}
                    </span>
                  </div>
                  <div style={{ color: "#aaa" }}>{comment.text}</div>
                </div>
              );
            }}
            renderHoverUtility={(getHoveredLine) => {
              const hovered = getHoveredLine();
              if (!hovered) return null;
              return (
                <button
                  onClick={() => {
                    setCommentInput({
                      line: hovered.lineNumber,
                      side: hovered.side,
                    });
                    setCommentText("");
                  }}
                  style={{
                    background: "#3b82f6",
                    border: "none",
                    borderRadius: 4,
                    color: "#fff",
                    fontSize: 12,
                    padding: "2px 6px",
                    cursor: "pointer",
                    lineHeight: 1,
                  }}
                  title="Add comment"
                >
                  +
                </button>
              );
            }}
          />
        ) : (
          <PatchDiff
            patch={SAMPLE_PATCH}
            options={{
              theme: "pierre-dark",
              diffStyle,
            }}
          />
        )}
      </div>

      {/* Comment input modal */}
      {commentInput && (
        <div
          style={{
            position: "fixed",
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            background: "#1e1e24",
            border: "1px solid #2a2a32",
            borderRadius: 8,
            padding: 16,
            width: 480,
            boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
            zIndex: 1000,
          }}
        >
          <div
            style={{
              fontSize: 12,
              color: "#888",
              marginBottom: 8,
            }}
          >
            Comment on line {commentInput.line} ({commentInput.side === "additions" ? "new" : "old"}{" "}
            side)
          </div>
          <textarea
            autoFocus
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.metaKey) {
                addComment(commentInput.line, commentInput.side);
              }
              if (e.key === "Escape") {
                setCommentInput(null);
              }
            }}
            placeholder="Write a comment..."
            style={{
              width: "100%",
              minHeight: 60,
              background: "#0a0a0b",
              border: "1px solid #2a2a32",
              borderRadius: 4,
              color: "#e0e0e0",
              padding: 8,
              fontSize: 13,
              fontFamily: "inherit",
              resize: "vertical",
              outline: "none",
            }}
          />
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 8,
              marginTop: 8,
            }}
          >
            <button
              onClick={() => setCommentInput(null)}
              style={{
                padding: "6px 12px",
                fontSize: 13,
                border: "1px solid #2a2a32",
                borderRadius: 4,
                background: "transparent",
                color: "#888",
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
            <button
              onClick={() => addComment(commentInput.line, commentInput.side)}
              disabled={!commentText.trim()}
              style={{
                padding: "6px 12px",
                fontSize: 13,
                border: "none",
                borderRadius: 4,
                background: commentText.trim() ? "#3b82f6" : "#1e1e24",
                color: commentText.trim() ? "#fff" : "#555",
                cursor: commentText.trim() ? "pointer" : "default",
              }}
            >
              Comment ⌘↵
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
