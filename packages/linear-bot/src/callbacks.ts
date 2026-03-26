/**
 * Callback handlers for control-plane completion notifications.
 * Uses richer response extraction and formats as Linear AgentActivities.
 */

import { Hono } from "hono";
import type { Env, CompletionCallback, ToolCallCallback } from "./types";
import {
  getLinearClient,
  emitAgentActivity,
  postIssueComment,
  updateAgentSession,
} from "./utils/linear-client";
import { extractAgentResponse, formatAgentResponse } from "./completion/extractor";
import { timingSafeEqual } from "@open-inspect/shared";
import { computeHmacHex } from "./utils/crypto";
import { makePlan } from "./plan";
import type { PlanStepStatus } from "./plan";
import { createLogger } from "./logger";
import { CompletionCallbackSchema, ToolCallCallbackSchema, ToolResultCallbackSchema } from "./schemas";

const log = createLogger("callback");

export async function verifyCallbackSignature<T extends { signature: string }>(
  payload: T,
  secret: string
): Promise<boolean> {
  const { signature, ...data } = payload;
  const expectedHex = await computeHmacHex(JSON.stringify(data), secret);
  return timingSafeEqual(signature, expectedHex);
}

export function isValidPayload(payload: unknown): payload is CompletionCallback {
  return CompletionCallbackSchema.safeParse(payload).success;
}

export const callbacksRouter = new Hono<{ Bindings: Env }>();

callbacksRouter.post("/complete", async (c) => {
  const startTime = Date.now();
  const traceId = c.req.header("x-trace-id") || crypto.randomUUID();
  const payload = await c.req.json();

  if (!isValidPayload(payload)) {
    log.warn("http.request", {
      trace_id: traceId,
      http_path: "/callbacks/complete",
      http_status: 400,
      outcome: "rejected",
      reject_reason: "invalid_payload",
      duration_ms: Date.now() - startTime,
    });
    return c.json({ error: "invalid payload" }, 400);
  }

  if (!c.env.INTERNAL_CALLBACK_SECRET) {
    log.error("http.request", {
      trace_id: traceId,
      http_path: "/callbacks/complete",
      http_status: 500,
      outcome: "error",
      reject_reason: "secret_not_configured",
      duration_ms: Date.now() - startTime,
    });
    return c.json({ error: "not configured" }, 500);
  }

  const isValid = await verifyCallbackSignature(payload, c.env.INTERNAL_CALLBACK_SECRET);
  if (!isValid) {
    log.warn("http.request", {
      trace_id: traceId,
      http_path: "/callbacks/complete",
      http_status: 401,
      outcome: "rejected",
      reject_reason: "invalid_signature",
      duration_ms: Date.now() - startTime,
    });
    return c.json({ error: "unauthorized" }, 401);
  }

  c.executionCtx.waitUntil(handleCompletionCallback(payload, c.env, traceId));

  return c.json({ ok: true });
});

// ─── Tool Call Callback ──────────────────────────────────────────────────────

/** Format a tool call into Linear's action activity schema: { action, parameter }. */
export function formatToolAction(
  tool: string,
  args: Record<string, unknown>
): { action: string; parameter: string } {
  const file = String(args.filepath || args.file_path || args.path || "");
  switch (tool) {
    case "edit_file":
    case "Edit":
    case "write_file":
    case "Write":
      return { action: "Editing", parameter: file || "file" };
    case "read_file":
    case "Read":
      return { action: "Reading", parameter: file || "file" };
    case "bash":
    case "Bash":
    case "execute_command": {
      const cmd = String(args.command || args.cmd || "");
      return { action: "Running", parameter: cmd.length > 80 ? cmd.slice(0, 77) + "..." : cmd };
    }
    case "Glob":
    case "Grep":
      return { action: "Searching", parameter: String(args.pattern || args.query || "") };
    case "create-pull-request":
      return { action: "Creating PR", parameter: String(args.title || "") };
    default:
      return { action: tool, parameter: "" };
  }
}

/** Format a tool result into Linear's action activity schema with result field. */
export function formatToolResult(
  tool: string,
  args: Record<string, unknown>,
  result: string,
  isError: boolean
): { action: string; parameter: string; result: string } {
  const { parameter } = formatToolAction(tool, args);
  const pastTense: Record<string, string> = {
    Editing: "Edited",
    Reading: "Read",
    Running: "Ran",
    Searching: "Searched",
    "Creating PR": "Created PR",
  };
  const { action } = formatToolAction(tool, args);
  const doneAction = pastTense[action] || action;

  let resultText: string;
  if (isError) {
    resultText = `❌ ${result.slice(0, 200) || "Error"}`;
  } else if (result) {
    resultText = result.slice(0, 300);
  } else {
    resultText = "✅";
  }

  return { action: doneAction, parameter, result: resultText };
}

export function isValidToolCallPayload(payload: unknown): payload is ToolCallCallback {
  return ToolCallCallbackSchema.safeParse(payload).success;
}

callbacksRouter.post("/tool_call", async (c) => {
  const startTime = Date.now();
  const traceId = c.req.header("x-trace-id") || crypto.randomUUID();
  const payload = await c.req.json();

  if (!isValidToolCallPayload(payload)) {
    log.warn("http.request", {
      trace_id: traceId,
      http_path: "/callbacks/tool_call",
      http_status: 400,
      outcome: "rejected",
      reject_reason: "invalid_payload",
      duration_ms: Date.now() - startTime,
    });
    return c.json({ error: "invalid payload" }, 400);
  }

  if (!c.env.INTERNAL_CALLBACK_SECRET) {
    log.error("http.request", {
      trace_id: traceId,
      http_path: "/callbacks/tool_call",
      http_status: 500,
      outcome: "error",
      reject_reason: "secret_not_configured",
      duration_ms: Date.now() - startTime,
    });
    return c.json({ error: "not configured" }, 500);
  }

  const isValid = await verifyCallbackSignature(payload, c.env.INTERNAL_CALLBACK_SECRET);
  if (!isValid) {
    log.warn("http.request", {
      trace_id: traceId,
      http_path: "/callbacks/tool_call",
      http_status: 401,
      outcome: "rejected",
      reject_reason: "invalid_signature",
      session_id: payload.sessionId,
      duration_ms: Date.now() - startTime,
    });
    return c.json({ error: "unauthorized" }, 401);
  }

  c.executionCtx.waitUntil(
    (async () => {
      const processStart = Date.now();
      const { context } = payload;

      if (!context.agentSessionId || !context.organizationId) {
        log.debug("callback.tool_call", {
          trace_id: traceId,
          session_id: payload.sessionId,
          tool: payload.tool,
          outcome: "skipped",
          skip_reason: "missing_agent_context",
          duration_ms: Date.now() - processStart,
        });
        return;
      }

      // Default to true for backward compat with sessions created before this field existed
      if (context.emitToolProgressActivities === false) {
        log.debug("callback.tool_call", {
          trace_id: traceId,
          session_id: payload.sessionId,
          agent_session_id: context.agentSessionId,
          tool: payload.tool,
          outcome: "skipped",
          skip_reason: "activities_disabled",
          duration_ms: Date.now() - processStart,
        });
        return;
      }

      const client = await getLinearClient(c.env, context.organizationId);
      if (!client) {
        log.warn("callback.tool_call", {
          trace_id: traceId,
          session_id: payload.sessionId,
          agent_session_id: context.agentSessionId,
          org_id: context.organizationId,
          tool: payload.tool,
          outcome: "skipped",
          skip_reason: "no_oauth_token",
          duration_ms: Date.now() - processStart,
        });
        return;
      }

      try {
        const { action, parameter } = formatToolAction(payload.tool, payload.args);
        await emitAgentActivity(
          client,
          context.agentSessionId,
          { type: "action", action, parameter },
          true
        );

        // If this is a TodoWrite, use the agent's own task list as the Linear plan
        let changed = false;
        if (payload.tool.toLowerCase() === "todowrite" && Array.isArray(payload.args.todos)) {
          const todos = payload.args.todos as Array<{ content: string; status: string }>;
          const plan = todos.map((t) => ({
            content: t.content || "",
            status: (t.status === "completed" ? "completed"
              : t.status === "in_progress" ? "inProgress"
              : "pending") as PlanStepStatus,
          }));
          if (plan.length > 0) {
            await updateAgentSession(client, context.agentSessionId, { plan });
            changed = true;
          }
        }

        log.info("callback.tool_call", {
          trace_id: traceId,
          session_id: payload.sessionId,
          agent_session_id: context.agentSessionId,
          tool: payload.tool,
          outcome: "success",
          plan_updated: changed,
          duration_ms: Date.now() - processStart,
        });
      } catch (e) {
        log.warn("callback.tool_call", {
          trace_id: traceId,
          session_id: payload.sessionId,
          agent_session_id: context.agentSessionId,
          tool: payload.tool,
          outcome: "error",
          error: e instanceof Error ? e : new Error(String(e)),
          duration_ms: Date.now() - processStart,
        });
      }
    })()
  );

  return c.json({ ok: true });
});

// ─── Tool Result Callback ────────────────────────────────────────────────────

callbacksRouter.post("/tool_result", async (c) => {
  const startTime = Date.now();
  const traceId = c.req.header("x-trace-id") || crypto.randomUUID();
  const payload = await c.req.json();

  const parsed = ToolResultCallbackSchema.safeParse(payload);
  if (!parsed.success) {
    return c.json({ error: "invalid payload" }, 400);
  }

  if (!c.env.INTERNAL_CALLBACK_SECRET) {
    return c.json({ error: "not configured" }, 500);
  }

  const isValid = await verifyCallbackSignature(parsed.data, c.env.INTERNAL_CALLBACK_SECRET);
  if (!isValid) {
    return c.json({ error: "unauthorized" }, 401);
  }

  c.executionCtx.waitUntil(
    (async () => {
      const { context } = parsed.data;

      if (!context.agentSessionId || !context.organizationId) return;
      if (context.emitToolProgressActivities === false) return;

      const client = await getLinearClient(c.env, context.organizationId);
      if (!client) return;

      try {
        const { action, parameter, result } = formatToolResult(
          parsed.data.tool,
          {}, // args not available on result callback
          parsed.data.result,
          parsed.data.isError
        );
        await emitAgentActivity(
          client,
          context.agentSessionId,
          { type: "action", action, parameter, result },
          true // ephemeral
        );
        log.info("callback.tool_result", {
          trace_id: traceId,
          session_id: parsed.data.sessionId,
          agent_session_id: context.agentSessionId,
          tool: parsed.data.tool,
          outcome: "success",
          duration_ms: Date.now() - startTime,
        });
      } catch (e) {
        log.warn("callback.tool_result", {
          trace_id: traceId,
          session_id: parsed.data.sessionId,
          tool: parsed.data.tool,
          outcome: "error",
          error: e instanceof Error ? e : new Error(String(e)),
          duration_ms: Date.now() - startTime,
        });
      }
    })()
  );

  return c.json({ ok: true });
});

// ─── Completion Callback ─────────────────────────────────────────────────────

async function handleCompletionCallback(
  payload: CompletionCallback,
  env: Env,
  traceId?: string
): Promise<void> {
  const startTime = Date.now();
  const { sessionId, context } = payload;

  try {
    // Extract rich agent response from events
    const agentResponse = await extractAgentResponse(env, sessionId, payload.messageId, traceId);

    let message: string;
    let activityType: "response" | "error";

    const hasPr = agentResponse.artifacts.some((a) => a.type === "pr" && a.url);
    if (payload.success || hasPr) {
      // Agent completed (or at least created a PR before being stopped)
      activityType = "response";
      message = formatAgentResponse(agentResponse);
    } else {
      // Use "response" instead of "error" to keep the session active for follow-ups.
      // Linear auto-transitions to "error" state on error activities, which kills
      // follow-up webhooks.
      activityType = "response";
      if (agentResponse.textContent) {
        message = `⚠️ The agent was stopped.\n\n${agentResponse.textContent.slice(0, 500)}`;
      } else {
        message = `⚠️ The agent was stopped before completing the task.`;
      }
    }

    // Emit via Agent API if we have session context
    if (context.agentSessionId && context.organizationId) {
      const client = await getLinearClient(env, context.organizationId);
      if (client) {
        await emitAgentActivity(client, context.agentSessionId, {
          type: activityType,
          body: message,
        });

        // Update plan to completed/failed
        await updateAgentSession(client, context.agentSessionId, {
          plan: makePlan(payload.success ? "completed" : "failed"),
        });

        // Update externalUrls with PR link if available
        const prArtifact = agentResponse.artifacts.find((a) => a.type === "pr" && a.url);
        if (prArtifact) {
          await updateAgentSession(client, context.agentSessionId, {
            externalUrls: [{ label: "Pull Request", url: prArtifact.url }],
          });
        }

        log.info("callback.complete", {
          trace_id: traceId,
          session_id: sessionId,
          issue_id: context.issueId,
          issue_identifier: context.issueIdentifier,
          agent_session_id: context.agentSessionId,
          outcome: payload.success ? "success" : "failed",
          has_pr: agentResponse.artifacts.some((a) => a.type === "pr" && a.url),
          agent_success: payload.success,
          tool_call_count: agentResponse.toolCalls.length,
          artifact_count: agentResponse.artifacts.length,
          delivery: "agent_activity",
          delivery_outcome: "success",
          duration_ms: Date.now() - startTime,
        });
        return;
      }
      log.warn("callback.no_oauth_token", {
        trace_id: traceId,
        org_id: context.organizationId,
      });
    }

    // Fallback: post a comment (requires LINEAR_API_KEY)
    if (!env.LINEAR_API_KEY) {
      log.warn("callback.no_linear_api_key", {
        trace_id: traceId,
        session_id: sessionId,
        issue_id: context.issueId,
        message: "LINEAR_API_KEY not configured, cannot post fallback comment",
      });
      return;
    }

    const commentBody = payload.success
      ? `## 🤖 Open-Inspect completed\n\n${message}`
      : `## ⚠️ Open-Inspect encountered an issue\n\n${message}`;

    const result = await postIssueComment(env.LINEAR_API_KEY, context.issueId, commentBody);

    log.info("callback.complete", {
      trace_id: traceId,
      session_id: sessionId,
      issue_id: context.issueId,
      outcome: payload.success ? "success" : "failed",
      agent_success: payload.success,
      delivery: "comment_fallback",
      delivery_outcome: result.success ? "success" : "error",
      duration_ms: Date.now() - startTime,
    });
  } catch (error) {
    log.error("callback.complete", {
      trace_id: traceId,
      session_id: sessionId,
      issue_id: context.issueId,
      outcome: "error",
      error: error instanceof Error ? error : new Error(String(error)),
      duration_ms: Date.now() - startTime,
    });
  }
}
