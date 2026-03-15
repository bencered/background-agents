/**
 * Agent session event handler — orchestrates issue→session lifecycle.
 * Extracted from index.ts for modularity.
 */

import type { AgentSessionEventWebhookPayload } from "@linear/sdk/webhooks";
import type {
  Env,
  CallbackContext,
  LinearIssueDetails,
} from "./types";
import {
  CreateSessionResponseSchema,
  GetSessionResponseSchema,
  SessionEventsResponseSchema,
} from "@open-inspect/shared";
import type { SessionStatus } from "@open-inspect/shared";
import {
  getLinearClient,
  emitAgentActivity,
  fetchIssueDetails,
  updateAgentSession,
  getTeamStartedState,
  updateIssue,
  getAppUserId,
} from "./utils/linear-client";
import { generateInternalToken } from "./utils/internal";
import { getAvailableRepos } from "./classifier/repos";
import { getLinearConfig } from "./utils/integration-config";
import { createLogger } from "./logger";
import { makePlan } from "./plan";
import {
  extractModelFromLabels,
  resolveSessionModelSettings,
} from "./model-resolution";
import {
  getUserPreferences,
  lookupIssueSession,
  storeIssueSession,
  storePendingClassification,
  lookupPendingClassification,
  deletePendingClassification,
} from "./kv-store";
import { resolveRepoFromMappings } from "./utils/repo-mapping";
import type { PendingClassification } from "./kv-store";

const log = createLogger("handler");

// ─── SDK Type Helpers ────────────────────────────────────────────────────────

type Webhook = AgentSessionEventWebhookPayload;
type WebhookIssue = NonNullable<Webhook["agentSession"]["issue"]>;

/** Extract body text from the opaque agentActivity.content field. */
function getActivityBody(webhook: Webhook): string | undefined {
  const content = webhook.agentActivity?.content;
  if (!content || typeof content !== "object") return undefined;
  const c = content as Record<string, unknown>;
  return typeof c.body === "string" ? c.body : undefined;
}

/** Extract content type from the opaque agentActivity.content field. */
function getActivityContentType(webhook: Webhook): string | undefined {
  const content = webhook.agentActivity?.content;
  if (!content || typeof content !== "object") return undefined;
  const c = content as Record<string, unknown>;
  return typeof c.type === "string" ? c.type : undefined;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function getAuthHeaders(env: Env, traceId?: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (env.INTERNAL_CALLBACK_SECRET) {
    const authToken = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET);
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  if (traceId) headers["x-trace-id"] = traceId;
  return headers;
}

// ─── Sub-handlers ────────────────────────────────────────────────────────────

async function handleStop(webhook: Webhook, env: Env, traceId: string): Promise<void> {
  const startTime = Date.now();
  const agentSessionId = webhook.agentSession.id;
  const issueId = webhook.agentSession.issue?.id;

  if (issueId) {
    const existingSession = await lookupIssueSession(env, issueId);
    if (existingSession) {
      const headers = await getAuthHeaders(env, traceId);
      try {
        const stopRes = await env.CONTROL_PLANE.fetch(
          `https://internal/sessions/${existingSession.sessionId}/stop`,
          { method: "POST", headers }
        );
        log.info("agent_session.stopped", {
          trace_id: traceId,
          agent_session_id: agentSessionId,
          session_id: existingSession.sessionId,
          issue_id: issueId,
          stop_status: stopRes.status,
        });
      } catch (e) {
        log.error("agent_session.stop_failed", {
          trace_id: traceId,
          session_id: existingSession.sessionId,
          error: e instanceof Error ? e : new Error(String(e)),
        });
      }
      await env.LINEAR_KV.delete(`issue:${issueId}`);
    }
  }

  log.info("agent_session.stop_handled", {
    trace_id: traceId,
    action: webhook.action,
    agent_session_id: agentSessionId,
    duration_ms: Date.now() - startTime,
  });
}

async function handleFollowUp(
  webhook: Webhook,
  issue: WebhookIssue,
  env: Env,
  traceId: string
): Promise<void> {
  const startTime = Date.now();
  const agentSessionId = webhook.agentSession.id;
  const comment = webhook.agentSession.comment;
  const agentActivity = webhook.agentActivity;
  const orgId = webhook.organizationId;

  const client = await getLinearClient(env, orgId);
  if (!client) {
    log.error("agent_session.no_oauth_token", {
      trace_id: traceId,
      org_id: orgId,
      agent_session_id: agentSessionId,
    });
    return;
  }

  const existingSession = await lookupIssueSession(env, issue.id);
  if (!existingSession) return;

  const followUpContent = agentActivity?.content?.body || comment?.body || "Follow-up on the issue.";

  await emitAgentActivity(
    client,
    agentSessionId,
    {
      type: "thought",
      body: "Processing follow-up message...",
    },
    true
  );

  const headers = await getAuthHeaders(env, traceId);
  let sessionContext = "";
  try {
    const eventsRes = await env.CONTROL_PLANE.fetch(
      `https://internal/sessions/${existingSession.sessionId}/events?limit=20`,
      { method: "GET", headers }
    );
    if (eventsRes.ok) {
      const eventsData = SessionEventsResponseSchema.parse(await eventsRes.json());
      const recentTokens = eventsData.events.filter((e) => e.type === "token").slice(-1);
      if (recentTokens.length > 0) {
        const lastContent = String(recentTokens[0].data.content ?? "");
        if (lastContent) {
          sessionContext = `\n\n---\n**Previous agent response (summary):**\n${lastContent.slice(0, 500)}`;
        }
      }
    }
  } catch {
    /* best effort */
  }

  const promptRes = await env.CONTROL_PLANE.fetch(
    `https://internal/sessions/${existingSession.sessionId}/prompt`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        content: `Follow-up on ${issue.identifier}:\n\n${followUpContent}${sessionContext}`,
        authorId: `linear:${webhook.appUserId}`,
        source: "linear",
      }),
    }
  );

  if (promptRes.ok) {
    await emitAgentActivity(client, agentSessionId, {
      type: "response",
      body: `Follow-up sent to existing session.`,
    });
  } else {
    await emitAgentActivity(client, agentSessionId, {
      type: "error",
      body: "Failed to send follow-up to the existing session.",
    });
  }

  log.info("agent_session.followup", {
    trace_id: traceId,
    issue_identifier: issue.identifier,
    session_id: existingSession.sessionId,
    agent_session_id: agentSessionId,
    duration_ms: Date.now() - startTime,
  });
}

async function handleClassificationReply(
  webhook: Webhook,
  issue: WebhookIssue,
  pending: PendingClassification,
  env: Env,
  traceId: string
): Promise<void> {
  const startTime = Date.now();
  const agentSessionId = webhook.agentSession.id;
  const orgId = webhook.organizationId;

  const client = await getLinearClient(env, orgId);
  if (!client) {
    log.error("agent_session.no_oauth_token", {
      trace_id: traceId,
      org_id: orgId,
      agent_session_id: agentSessionId,
    });
    return;
  }

  // Extract repo name from user's reply
  // Per Linear docs: prompted action → reply in agentActivity.content.body
  const activityBody = getActivityBody(webhook);
  const replyText = (
    activityBody ||
    webhook.agentSession.comment?.body ||
    ""
  ).trim();

  if (!replyText) {
    await emitAgentActivity(client, agentSessionId, {
      type: "error",
      body: "I didn't receive a repository name. Please reply with the repository (e.g. `owner/name` or just `name`).",
    });
    return;
  }

  // Try to match against available repos
  const repos = await getAvailableRepos(env, traceId);
  const normalizedReply = replyText.toLowerCase().replace(/[`*]/g, "").trim();

  let matchedRepo = repos.find(
    (r) => `${r.owner}/${r.name}`.toLowerCase() === normalizedReply
  );
  if (!matchedRepo) {
    matchedRepo = repos.find((r) => r.name.toLowerCase() === normalizedReply);
  }
  if (!matchedRepo) {
    // Fuzzy: check if reply contains a repo name
    matchedRepo = repos.find(
      (r) =>
        normalizedReply.includes(r.name.toLowerCase()) ||
        normalizedReply.includes(`${r.owner}/${r.name}`.toLowerCase())
    );
  }

  if (!matchedRepo) {
    await emitAgentActivity(client, agentSessionId, {
      type: "elicitation",
      body: `I couldn't find a repository matching "${replyText}". Available repositories:\n\n${repos.map((r) => `- **${r.owner}/${r.name}**${r.description ? `: ${r.description}` : ""}`).join("\n")}\n\nPlease reply with an exact repository name.`,
    });
    return;
  }

  // Clean up pending state
  await deletePendingClassification(env, issue.id);

  log.info("agent_session.classification_resolved", {
    trace_id: traceId,
    issue_identifier: issue.identifier,
    repo: `${matchedRepo.owner}/${matchedRepo.name}`,
    reply: replyText,
    duration_ms: Date.now() - startTime,
  });

  // Now create a synthetic webhook that handleNewSession can process,
  // but with the repo pre-resolved. Easiest: just call into the session
  // creation logic directly. We'll re-invoke handleNewSession — the repo
  // resolution will still run but we inject a project mapping temporarily.
  // Actually cleaner: store a temporary issue-level override and let it resolve.

  // Store a temporary project mapping for this issue's project (if any) or
  // just proceed with direct session creation. Let's do direct creation
  // to avoid complexity.

  const repoOwner = matchedRepo.owner;
  const repoName = matchedRepo.name;
  const repoFullName = `${repoOwner}/${repoName}`;

  await emitAgentActivity(
    client,
    agentSessionId,
    { type: "thought", body: `Creating coding session on ${repoFullName}...` },
    true
  );

  // Resolve model
  const integrationConfig = await getLinearConfig(env, repoFullName.toLowerCase());
  if (
    integrationConfig.enabledRepos !== null &&
    !integrationConfig.enabledRepos.includes(repoFullName.toLowerCase())
  ) {
    await emitAgentActivity(client, agentSessionId, {
      type: "error",
      body: `The Linear integration is not enabled for \`${repoFullName}\`.`,
    });
    return;
  }

  let userModel: string | undefined;
  let userReasoningEffort: string | undefined;
  if (pending.appUserId) {
    const prefs = await getUserPreferences(env, pending.appUserId);
    if (prefs?.model) userModel = prefs.model;
    userReasoningEffort = prefs?.reasoningEffort;
  }

  const issueDetails = await fetchIssueDetails(client, issue.id);
  const labels = issueDetails?.labels || [];
  const labelModel = extractModelFromLabels(labels);
  const { model, reasoningEffort } = resolveSessionModelSettings({
    envDefaultModel: env.DEFAULT_MODEL,
    configModel: integrationConfig.model,
    configReasoningEffort: integrationConfig.reasoningEffort,
    allowUserPreferenceOverride: integrationConfig.allowUserPreferenceOverride,
    allowLabelModelOverride: integrationConfig.allowLabelModelOverride,
    userModel,
    userReasoningEffort,
    labelModel,
  });

  // Create session
  const headers = await getAuthHeaders(env, traceId);
  const sessionRes = await env.CONTROL_PLANE.fetch("https://internal/sessions", {
    method: "POST",
    headers,
    body: JSON.stringify({
      repoOwner,
      repoName,
      title: `${issue.identifier}: ${issue.title}`,
      model,
      reasoningEffort,
    }),
  });

  if (!sessionRes.ok) {
    let errBody = "";
    try { errBody = await sessionRes.text(); } catch { /* ignore */ }
    await emitAgentActivity(client, agentSessionId, {
      type: "error",
      body: `Failed to create a coding session.\n\n\`HTTP ${sessionRes.status}: ${errBody.slice(0, 200)}\``,
    });
    return;
  }

  const session = CreateSessionResponseSchema.parse(await sessionRes.json());

  await storeIssueSession(env, issue.id, {
    sessionId: session.sessionId,
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    repoOwner,
    repoName,
    model,
    agentSessionId,
    createdAt: Date.now(),
  });

  await updateAgentSession(client, agentSessionId, {
    plan: makePlan("session_created"),
  });

  // Build and send prompt
  const prompt = webhook.promptContext || buildPrompt(issue, issueDetails, webhook.agentSession.comment);
  const callbackContext: CallbackContext = {
    source: "linear",
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    issueUrl: issue.url,
    repoFullName,
    model,
    agentSessionId,
    organizationId: orgId,
    emitToolProgressActivities: integrationConfig.emitToolProgressActivities,
  };

  const promptRes = await env.CONTROL_PLANE.fetch(
    `https://internal/sessions/${session.sessionId}/prompt`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        content: prompt,
        authorId: `linear:${webhook.appUserId}`,
        source: "linear",
        callbackContext,
      }),
    }
  );

  if (!promptRes.ok) {
    let errBody = "";
    try { errBody = await promptRes.text(); } catch { /* ignore */ }
    await emitAgentActivity(client, agentSessionId, {
      type: "error",
      body: `Failed to send prompt.\n\n\`HTTP ${promptRes.status}: ${errBody.slice(0, 200)}\``,
    });
    return;
  }

  await emitAgentActivity(client, agentSessionId, {
    type: "response",
    body: `Working on \`${repoFullName}\` with **${model}**.`,
  });

  log.info("agent_session.session_created_from_clarification", {
    trace_id: traceId,
    session_id: session.sessionId,
    agent_session_id: agentSessionId,
    issue_identifier: issue.identifier,
    repo: repoFullName,
    model,
    duration_ms: Date.now() - startTime,
  });
}

async function handleNewSession(
  webhook: Webhook,
  issue: WebhookIssue,
  env: Env,
  traceId: string
): Promise<void> {
  const startTime = Date.now();
  const agentSessionId = webhook.agentSession.id;
  const comment = webhook.agentSession.comment;
  const orgId = webhook.organizationId;

  const client = await getLinearClient(env, orgId);
  if (!client) {
    log.error("agent_session.no_oauth_token", {
      trace_id: traceId,
      org_id: orgId,
      agent_session_id: agentSessionId,
    });
    return;
  }

  await updateAgentSession(client, agentSessionId, { plan: makePlan("start") });
  await emitAgentActivity(
    client,
    agentSessionId,
    {
      type: "thought",
      body: "Analyzing issue and resolving repository...",
    },
    true
  );

  // Fetch full issue details for context
  const issueDetails = await fetchIssueDetails(client, issue.id);
  const labels = issueDetails?.labels || issue.labels || [];
  const labelNames = labels.map((l) => l.name);
  const projectInfo = issueDetails?.project || issue.project;

  // ─── Resolve repo ─────────────────────────────────────────────────────

  let repoOwner: string | null = null;
  let repoName: string | null = null;
  let repoFullName: string | null = null;
  let classificationReasoning: string | null = null;

  // 0. If this is a "prompted" action (reply to elicitation), check if the
  //    user's reply is a repo name. This handles both fresh pending state
  //    AND cases where pending state was lost (e.g. pre-fix invocations).
  if (webhook.action === "prompted") {
    const replyText = (
      getActivityBody(webhook) ||
      webhook.agentSession.comment?.body ||
      ""
    ).trim().toLowerCase().replace(/[`*]/g, "");

    if (replyText) {
      const repos = await getAvailableRepos(env, traceId);
      const matched =
        repos.find((r) => `${r.owner}/${r.name}`.toLowerCase() === replyText) ||
        repos.find((r) => r.name.toLowerCase() === replyText) ||
        repos.find((r) => replyText.includes(r.name.toLowerCase()) || replyText.includes(`${r.owner}/${r.name}`.toLowerCase()));

      if (matched) {
        repoOwner = matched.owner;
        repoName = matched.name;
        repoFullName = `${matched.owner}/${matched.name}`;
        classificationReasoning = `User specified ${repoFullName}`;

        // Clean up any pending classification
        await deletePendingClassification(env, issue.id);
      }
    }
  }

  // 1. Check D1 project/team→repo mapping (project takes priority over team)
  if (!repoOwner) {
    const teamId = issue.team?.id ?? null;
    const projectId = projectInfo?.id ?? null;
    const resolved = await resolveRepoFromMappings(env, {
      teamId,
      projectId,
      labels: labelNames,
    });
    if (resolved) {
      repoOwner = resolved.owner;
      repoName = resolved.name;
      repoFullName = `${resolved.owner}/${resolved.name}`;
      classificationReasoning = resolved.reasoning;
    }
  }

  // 3. Auto-select if only one repo available
  if (!repoOwner) {
    const repos = await getAvailableRepos(env, traceId);
    log.info("agent_session.available_repos", {
      trace_id: traceId,
      issue_identifier: issue.identifier,
      repo_count: repos.length,
      repos: repos.map((r) => `${r.owner}/${r.name}`),
    });
    if (repos.length === 1) {
      repoOwner = repos[0].owner;
      repoName = repos[0].name;
      repoFullName = `${repos[0].owner}/${repos[0].name}`;
      classificationReasoning = "Only one repository available";
    }
  }

  // 4. Fall back to elicitation (no LLM classifier — use Linear's suggestions or ask the user)
  if (!repoOwner) {
    const fallbackRepos = await getAvailableRepos(env, traceId);
    const repoOptions = fallbackRepos.map((r) => `${r.owner}/${r.name}`);

    const elicitationBody = repoOptions.length > 0
      ? `I couldn't automatically determine which repository to work on.\n\n**Available repositories:**\n${repoOptions.map((r) => `- **${r}**`).join("\n")}\n\nPlease reply with the repository name.`
      : "No repositories are configured. Please add a repository first.";

    await emitAgentActivity(
      client,
      agentSessionId,
      { type: "response", body: elicitationBody }
    );

    // Store pending state so follow-up reply can complete resolution
    await storePendingClassification(env, issue.id, {
      agentSessionId,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      issueTitle: issue.title,
      issueDescription: issue.description,
      issueUrl: issue.url,
      labels: labelNames,
      projectName: projectInfo?.name,
      organizationId: orgId,
      appUserId: webhook.appUserId,
      createdAt: Date.now(),
    });

    log.info("agent_session.elicitation_fallback", {
      trace_id: traceId,
      issue_identifier: issue.identifier,
      available_repos: repoOptions.length,
    });
    return;
  }

  if (!repoOwner || !repoName || !repoFullName) {
    const fallbackRepos = await getAvailableRepos(env, traceId);
    const fallbackOptions = fallbackRepos.map((r) => `${r.owner}/${r.name}`);
    await emitAgentActivity(
      client,
      agentSessionId,
      {
        type: "elicitation",
        body: fallbackOptions.length > 0
          ? `I couldn't determine which repository to work on.\n\n**Available repositories:**\n${fallbackOptions.map((r) => `- **${r}**`).join("\n")}\n\nPlease select a repository.`
          : "I couldn't determine which repository to work on. Please configure a project→repo or team→repo mapping and try again.",
      },
      false,
      fallbackOptions.length > 0 ? "select" : undefined,
      fallbackOptions.length > 0 ? { options: fallbackOptions } : undefined
    );

    await storePendingClassification(env, issue.id, {
      agentSessionId,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      issueTitle: issue.title,
      issueDescription: issue.description,
      issueUrl: issue.url,
      labels: labelNames,
      projectName: projectInfo?.name,
      organizationId: orgId,
      appUserId: webhook.appUserId,
      createdAt: Date.now(),
    });

    log.warn("agent_session.repo_resolution_failed", {
      trace_id: traceId,
      issue_identifier: issue.identifier,
    });
    return;
  }

  const integrationConfig = await getLinearConfig(env, repoFullName.toLowerCase());
  if (
    integrationConfig.enabledRepos !== null &&
    !integrationConfig.enabledRepos.includes(repoFullName.toLowerCase())
  ) {
    await emitAgentActivity(client, agentSessionId, {
      type: "error",
      body: `The Linear integration is not enabled for \`${repoFullName}\`.`,
    });
    log.info("agent_session.repo_not_enabled", {
      trace_id: traceId,
      issue_identifier: issue.identifier,
      repo: repoFullName,
    });
    return;
  }

  // ─── Resolve model ────────────────────────────────────────────────────

  let userModel: string | undefined;
  let userReasoningEffort: string | undefined;
  const appUserId = webhook.appUserId;
  if (appUserId) {
    const prefs = await getUserPreferences(env, appUserId);
    if (prefs?.model) {
      userModel = prefs.model;
    }
    userReasoningEffort = prefs?.reasoningEffort;
  }

  const labelModel = extractModelFromLabels(labels);
  const { model, reasoningEffort } = resolveSessionModelSettings({
    envDefaultModel: env.DEFAULT_MODEL,
    configModel: integrationConfig.model,
    configReasoningEffort: integrationConfig.reasoningEffort,
    allowUserPreferenceOverride: integrationConfig.allowUserPreferenceOverride,
    allowLabelModelOverride: integrationConfig.allowLabelModelOverride,
    userModel,
    userReasoningEffort,
    labelModel,
  });

  // ─── Create session ───────────────────────────────────────────────────

  await updateAgentSession(client, agentSessionId, { plan: makePlan("repo_resolved") });
  await emitAgentActivity(
    client,
    agentSessionId,
    {
      type: "thought",
      body: `Creating coding session on ${repoFullName} (model: ${model})...`,
    },
    true
  );

  const headers = await getAuthHeaders(env, traceId);

  const sessionRes = await env.CONTROL_PLANE.fetch("https://internal/sessions", {
    method: "POST",
    headers,
    body: JSON.stringify({
      repoOwner,
      repoName,
      title: `${issue.identifier}: ${issue.title}`,
      model,
      reasoningEffort,
    }),
  });

  if (!sessionRes.ok) {
    let sessionErrBody = "";
    try {
      sessionErrBody = await sessionRes.text();
    } catch {
      /* ignore */
    }
    await emitAgentActivity(client, agentSessionId, {
      type: "error",
      body: `Failed to create a coding session.\n\n\`HTTP ${sessionRes.status}: ${sessionErrBody.slice(0, 200)}\``,
    });
    log.error("control_plane.create_session", {
      trace_id: traceId,
      issue_identifier: issue.identifier,
      repo: repoFullName,
      http_status: sessionRes.status,
      response_body: sessionErrBody.slice(0, 500),
      duration_ms: Date.now() - startTime,
    });
    return;
  }

  const session = CreateSessionResponseSchema.parse(await sessionRes.json());

  await storeIssueSession(env, issue.id, {
    sessionId: session.sessionId,
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    repoOwner: repoOwner!,
    repoName: repoName!,
    model,
    agentSessionId,
    createdAt: Date.now(),
  });

  // Update plan
  await updateAgentSession(client, agentSessionId, {
    plan: makePlan("session_created"),
  });

  // Move issue to "started" status if it's not already in a started/completed state
  const teamId = issue.team?.id;
  if (teamId) {
    const startedState = await getTeamStartedState(client, teamId);
    if (startedState) {
      await updateIssue(client, issue.id, { stateId: startedState.id });
      log.info("agent_session.issue_moved_to_started", {
        trace_id: traceId,
        issue_id: issue.id,
        state: startedState.name,
      });
    }
  }

  // Set the bot as delegate on the issue
  const botUserId = await getAppUserId(client);
  if (botUserId) {
    await updateIssue(client, issue.id, { delegateId: botUserId });
  }

  // ─── Build and send prompt ────────────────────────────────────────────

  // Prefer Linear's promptContext (includes issue, comments, guidance)
  const prompt = webhook.promptContext || buildPrompt(issue, issueDetails, comment);
  const callbackContext: CallbackContext = {
    source: "linear",
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    issueUrl: issue.url,
    repoFullName: repoFullName!,
    model,
    agentSessionId,
    organizationId: orgId,
    emitToolProgressActivities: integrationConfig.emitToolProgressActivities,
  };

  const promptRes = await env.CONTROL_PLANE.fetch(
    `https://internal/sessions/${session.sessionId}/prompt`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        content: prompt,
        authorId: `linear:${webhook.appUserId}`,
        source: "linear",
        callbackContext,
      }),
    }
  );

  if (!promptRes.ok) {
    let promptErrBody = "";
    try {
      promptErrBody = await promptRes.text();
    } catch {
      /* ignore */
    }
    await emitAgentActivity(client, agentSessionId, {
      type: "error",
      body: `Failed to send the prompt to the coding session.\n\n\`HTTP ${promptRes.status}: ${promptErrBody.slice(0, 200)}\``,
    });
    log.error("control_plane.send_prompt", {
      trace_id: traceId,
      session_id: session.sessionId,
      issue_identifier: issue.identifier,
      http_status: promptRes.status,
      response_body: promptErrBody.slice(0, 500),
      duration_ms: Date.now() - startTime,
    });
    return;
  }

  await emitAgentActivity(client, agentSessionId, {
    type: "response",
    body: `Working on \`${repoFullName}\` with **${model}**.${classificationReasoning ? `\n\n*${classificationReasoning}*` : ""}`,
  });

  log.info("agent_session.session_created", {
    trace_id: traceId,
    session_id: session.sessionId,
    agent_session_id: agentSessionId,
    issue_identifier: issue.identifier,
    repo: repoFullName,
    model,
    classification_reasoning: classificationReasoning,
    duration_ms: Date.now() - startTime,
  });
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────

export async function handleAgentSessionEvent(
  webhook: Webhook,
  env: Env,
  traceId: string
): Promise<void> {
  const agentSessionId = webhook.agentSession.id;
  const issue = webhook.agentSession.issue;

  log.info("agent_session.received", {
    trace_id: traceId,
    action: webhook.action,
    agent_session_id: agentSessionId,
    issue_id: issue?.id,
    issue_identifier: issue?.identifier,
    has_comment: Boolean(webhook.agentSession.comment),
    org_id: webhook.organizationId,
  });

  // Stop handling
  if (webhook.action === "stopped" || webhook.action === "cancelled") {
    return handleStop(webhook, env, traceId);
  }

  if (!issue) {
    log.warn("agent_session.no_issue", { trace_id: traceId, agent_session_id: agentSessionId });
    return;
  }

  // Handle stop signal from user
  if (webhook.agentActivity?.signal === "stop") {
    const stopSession = await lookupIssueSession(env, issue.id);
    if (stopSession) {
      const headers = await getAuthHeaders(env, traceId);
      try {
        await env.CONTROL_PLANE.fetch(
          `https://internal/sessions/${stopSession.sessionId}/stop`,
          { method: "POST", headers }
        );
      } catch { /* best effort */ }
      await env.LINEAR_KV.delete(`issue:${issue.id}`);
    }
    const client = await getLinearClient(env, webhook.organizationId);
    if (client) {
      await emitAgentActivity(client, agentSessionId, {
        type: "response",
        body: stopSession
          ? `Stopped working on this issue. Session has been terminated.`
          : "No active session found for this issue.",
      });
    }
    log.info("agent_session.stop_signal", {
      trace_id: traceId,
      agent_session_id: agentSessionId,
      issue_id: issue.id,
      had_session: Boolean(stopSession),
    });
    return;
  }

  // Check if there's an existing coding session for this issue
  const existingSession = await lookupIssueSession(env, issue.id);
  log.info("agent_session.dispatch_state", {
    trace_id: traceId,
    issue_id: issue.id,
    has_existing_session: Boolean(existingSession),
    existing_session_id: existingSession?.sessionId,
  });

  if (existingSession) {
    // Verify it's still alive
    const headers = await getAuthHeaders(env, traceId);
    let isAlive = false;
    try {
      const statusRes = await env.CONTROL_PLANE.fetch(
        `https://internal/sessions/${existingSession.sessionId}`,
        { method: "GET", headers }
      );
      if (statusRes.ok) {
        const sessionData = GetSessionResponseSchema.parse(await statusRes.json());
        const terminalStatuses: Set<SessionStatus> = new Set(["completed", "archived", "cancelled", "failed"]);
        isAlive = !terminalStatuses.has(sessionData.status);
      }
    } catch {
      // Can't reach control plane — assume alive to avoid data loss
      isAlive = true;
    }

    if (isAlive) {
      // Route ANY comment to the existing session
      return handleFollowUp(webhook, issue, env, traceId);
    }

    // Session is dead — clean up
    await env.LINEAR_KV.delete(`issue:${issue.id}`);
    log.info("agent_session.stale_session_cleared", {
      trace_id: traceId,
      session_id: existingSession.sessionId,
      issue_id: issue.id,
    });
  }

  // Check for pending classification (user replying to elicitation)
  const pending = await lookupPendingClassification(env, issue.id);
  log.info("agent_session.dispatch_route", {
    trace_id: traceId,
    issue_id: issue.id,
    has_pending_classification: Boolean(pending),
    route: pending ? "classification_reply" : "new_session",
  });
  if (pending) {
    return handleClassificationReply(webhook, issue, pending, env, traceId);
  }

  // New session
  return handleNewSession(webhook, issue, env, traceId);
}

// ─── Prompt Builder ──────────────────────────────────────────────────────────

function buildPrompt(
  issue: { identifier: string; title: string; description?: string | null; url: string },
  issueDetails: LinearIssueDetails | null,
  comment?: { body: string } | null
): string {
  const parts: string[] = [
    `Linear Issue: ${issue.identifier} — ${issue.title}`,
    `URL: ${issue.url}`,
    "",
  ];

  if (issue.description) {
    parts.push(issue.description);
  } else {
    parts.push("(No description provided)");
  }

  // Add context from full issue details
  if (issueDetails) {
    if (issueDetails.labels.length > 0) {
      parts.push("", `**Labels:** ${issueDetails.labels.map((l) => l.name).join(", ")}`);
    }
    if (issueDetails.project) {
      parts.push(`**Project:** ${issueDetails.project.name}`);
    }
    if (issueDetails.assignee) {
      parts.push(`**Assignee:** ${issueDetails.assignee.name}`);
    }
    if (issueDetails.priorityLabel) {
      parts.push(`**Priority:** ${issueDetails.priorityLabel}`);
    }

    // Include recent comments for context
    if (issueDetails.comments.length > 0) {
      parts.push("", "---", "**Recent comments:**");
      for (const c of issueDetails.comments.slice(-5)) {
        const author = c.user?.name || "Unknown";
        parts.push(`- **${author}:** ${c.body.slice(0, 200)}`);
      }
    }
  }

  if (comment?.body) {
    parts.push("", "---", `**Agent instruction:** ${comment.body}`);
  }

  parts.push(
    "",
    "Please implement the changes described in this issue. Create a pull request when done."
  );

  return parts.join("\n");
}
