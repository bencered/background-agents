/**
 * Linear API client utilities — OAuth + @linear/sdk.
 */

import { LinearClient } from "@linear/sdk";
// AgentActivityCreateInput not exported from @linear/sdk — use inline type
import type { Env, LinearIssueDetails } from "../types";
import { OAuthTokenResponseSchema, StoredTokenDataSchema } from "../schemas";
import { timingSafeEqual } from "@open-inspect/shared";
import { computeHmacHex } from "./crypto";
import { createLogger } from "../logger";

const log = createLogger("linear-client");

const LINEAR_API_URL = "https://api.linear.app/graphql";
const OAUTH_TOKEN_KEY_PREFIX = "oauth:token:";

// Re-export LinearClient as the client type for callers
export type LinearApiClient = LinearClient;

// ─── StoredTokenData ─────────────────────────────────────────────────────────

interface StoredTokenData {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

// ─── OAuth Helpers ───────────────────────────────────────────────────────────

function getWorkspaceTokenKey(orgId: string): string {
  return `${OAUTH_TOKEN_KEY_PREFIX}${orgId}`;
}

export function buildOAuthAuthorizeUrl(env: Env): string {
  const authUrl = new URL("https://linear.app/oauth/authorize");
  authUrl.searchParams.set("client_id", env.LINEAR_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", `${env.WORKER_URL}/oauth/callback`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "read,write,app:assignable,app:mentionable");
  authUrl.searchParams.set("actor", "app");
  return authUrl.toString();
}

export async function exchangeCodeForToken(
  env: Env,
  code: string
): Promise<{ orgId: string; orgName: string }> {
  const tokenRes = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: env.LINEAR_CLIENT_ID,
      client_secret: env.LINEAR_CLIENT_SECRET,
      code,
      redirect_uri: `${env.WORKER_URL}/oauth/callback`,
    }),
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    throw new Error(`Token exchange failed: ${errText}`);
  }

  const tokenData = OAuthTokenResponseSchema.parse(await tokenRes.json());

  // Use SDK to get workspace info
  const tempClient = new LinearClient({ accessToken: tokenData.access_token });
  const viewer = await tempClient.viewer;
  const org = await viewer.organization;
  if (!org) throw new Error("No organization found");

  const stored: StoredTokenData = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_at: Date.now() + tokenData.expires_in * 1000,
  };
  await env.LINEAR_KV.put(getWorkspaceTokenKey(org.id), JSON.stringify(stored));

  return { orgId: org.id, orgName: org.name };
}

export async function getOAuthToken(env: Env, orgId: string): Promise<string | null> {
  const raw = await env.LINEAR_KV.get(getWorkspaceTokenKey(orgId));
  if (!raw) return null;

  let tokenData: StoredTokenData;
  try {
    tokenData = StoredTokenDataSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }

  if (Date.now() < tokenData.expires_at - 5 * 60 * 1000) {
    return tokenData.access_token;
  }

  if (!tokenData.refresh_token) return null;

  try {
    log.info("oauth.refresh", { org_id: orgId });
    const res = await fetch("https://api.linear.app/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: env.LINEAR_CLIENT_ID,
        client_secret: env.LINEAR_CLIENT_SECRET,
        refresh_token: tokenData.refresh_token,
      }),
    });

    if (!res.ok) {
      log.error("oauth.refresh_failed", { org_id: orgId, status: res.status });
      return null;
    }

    const refreshed = OAuthTokenResponseSchema.parse(await res.json());
    const newStored: StoredTokenData = {
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token,
      expires_at: Date.now() + refreshed.expires_in * 1000,
    };
    await env.LINEAR_KV.put(getWorkspaceTokenKey(orgId), JSON.stringify(newStored));
    return newStored.access_token;
  } catch (err) {
    log.error("oauth.refresh_error", {
      org_id: orgId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return null;
  }
}

// ─── Linear SDK Client ──────────────────────────────────────────────────────

export async function getLinearClient(env: Env, orgId: string): Promise<LinearClient | null> {
  const token = await getOAuthToken(env, orgId);
  if (!token) return null;
  return new LinearClient({ accessToken: token });
}

// ─── Agent Activities ────────────────────────────────────────────────────────

export async function emitAgentActivity(
  client: LinearClient,
  agentSessionId: string,
  content: Record<string, unknown>,
  ephemeral?: boolean,
  signal?: string,
  signalMetadata?: Record<string, unknown>
): Promise<void> {
  try {
    const input: any = { agentSessionId, content, ephemeral };
    if (signal) input.signal = signal;
    if (signalMetadata) input.signalMetadata = signalMetadata;
    await client.createAgentActivity(input);
  } catch (err) {
    log.error("linear.emit_activity_failed", {
      agent_session_id: agentSessionId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
  }
}

/**
 * Fetch the first "started" workflow state for a team (lowest position).
 */
export async function getTeamStartedState(
  client: LinearClient,
  teamId: string
): Promise<{ id: string; name: string } | null> {
  try {
    const team = await client.team(teamId);
    const states = await team.states({ filter: { type: { eq: "started" } } });
    const nodes = states.nodes;

    if (!nodes || nodes.length === 0) return null;
    const sorted = [...nodes].sort((a, b) => a.position - b.position);
    return { id: sorted[0].id, name: sorted[0].name };
  } catch (err) {
    log.error("linear.get_team_started_state", {
      team_id: teamId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return null;
  }
}

/**
 * Update an issue (status, delegate, etc.)
 */
export async function updateIssue(
  client: LinearClient,
  issueId: string,
  input: Record<string, unknown>
): Promise<boolean> {
  try {
    const result = await client.updateIssue(issueId, input);
    return result.success;
  } catch (err) {
    log.error("linear.update_issue_failed", {
      issue_id: issueId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return false;
  }
}

/**
 * Get the app user ID for the current OAuth token (the bot's identity).
 */
export async function getAppUserId(client: LinearClient): Promise<string | null> {
  try {
    const viewer = await client.viewer;
    return viewer.id;
  } catch {
    return null;
  }
}

// ─── Issue Details ───────────────────────────────────────────────────────────

/**
 * Fetch full issue details from Linear API.
 */
export async function fetchIssueDetails(
  client: LinearClient,
  issueId: string
): Promise<LinearIssueDetails | null> {
  try {
    const issue = await client.issue(issueId);
    const labels = await issue.labels();
    const project = await issue.project;
    const assignee = await issue.assignee;
    const team = await issue.team;
    const comments = await issue.comments({ first: 10 });

    if (!team) return null;

    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? null,
      url: issue.url,
      priority: issue.priority,
      priorityLabel: issue.priorityLabel,
      labels: labels.nodes.map((l) => ({ id: l.id, name: l.name })),
      project: project ? { id: project.id, name: project.name } : null,
      assignee: assignee ? { id: assignee.id, name: assignee.name } : null,
      team: { id: team.id, key: team.key, name: team.name },
      comments: await Promise.all(
        comments.nodes.map(async (c) => {
          const user = await c.user;
          return {
            body: c.body,
            user: user ? { name: user.displayName } : undefined,
          };
        })
      ),
    };
  } catch (err) {
    log.error("linear.fetch_issue_details", {
      issue_id: issueId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return null;
  }
}

// ─── Agent Session Management ────────────────────────────────────────────────

/**
 * Update an agent session (externalUrls, plan, etc.)
 */
export async function updateAgentSession(
  client: LinearClient,
  agentSessionId: string,
  input: Record<string, unknown>
): Promise<void> {
  try {
    await client.updateAgentSession(agentSessionId, input);
  } catch (err) {
    log.error("linear.update_session_failed", {
      agent_session_id: agentSessionId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
  }
}

/**
 * Use Linear's built-in repo suggestion API for issue→repo matching.
 */
export async function getRepoSuggestions(
  client: LinearClient,
  issueId: string,
  agentSessionId: string,
  candidateRepos: Array<{ hostname: string; repositoryFullName: string }>
): Promise<Array<{ repositoryFullName: string; confidence: number }>> {
  try {
    const result = await (client as any).issueRepositorySuggestions(issueId, agentSessionId, candidateRepos);
    return result.suggestions.map((s: any) => ({
      repositoryFullName: s.repositoryFullName,
      confidence: s.confidence,
    }));
  } catch (err) {
    log.error("linear.repo_suggestions_failed", {
      issue_id: issueId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return [];
  }
}

// ─── Webhook Verification ────────────────────────────────────────────────────

export async function verifyLinearWebhook(
  body: string,
  signature: string | null,
  secret: string
): Promise<boolean> {
  if (!signature) return false;
  const expectedHex = await computeHmacHex(body, secret);
  return timingSafeEqual(signature, expectedHex);
}

// ─── Comment Posting (fallback using raw API key) ────────────────────────────

export async function postIssueComment(
  apiKey: string,
  issueId: string,
  body: string
): Promise<{ success: boolean }> {
  const response = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({
      query: `
        mutation CommentCreate($input: CommentCreateInput!) {
          commentCreate(input: $input) { success }
        }
      `,
      variables: { input: { issueId, body } },
    }),
  });

  if (!response.ok) return { success: false };
  const data = await response.json() as { data?: { commentCreate?: { success: boolean } } }; // intentional cast — fallback path
  return { success: data?.data?.commentCreate?.success ?? false };
}
