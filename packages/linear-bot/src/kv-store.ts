/**
 * KV accessor helpers for config, issue sessions, and event deduplication.
 */

import type {
  Env,
  TriggerConfig,
  TeamRepoMapping,
  ProjectRepoMapping,
  UserPreferences,
  IssueSession,
} from "./types";
import {
  TeamRepoMappingSchema,
  ProjectRepoMappingSchema,
  TriggerConfigSchema,
  UserPreferencesSchema,
  IssueSessionSchema,
  PendingClassificationSchema,
} from "./schemas";
import { createLogger } from "./logger";

const log = createLogger("kv-store");

export const DEFAULT_TRIGGER_CONFIG: TriggerConfig = {
  triggerLabel: "agent",
  autoTriggerOnCreate: false,
  triggerCommand: "@agent",
};

export async function getTeamRepoMapping(env: Env): Promise<TeamRepoMapping> {
  try {
    const data = await env.LINEAR_KV.get("config:team-repos", "json");
    return TeamRepoMappingSchema.parse(data);
  } catch (e) {
    log.debug("kv.get_team_repo_mapping_failed", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return {};
}

export async function getProjectRepoMapping(env: Env): Promise<ProjectRepoMapping> {
  try {
    const data = await env.LINEAR_KV.get("config:project-repos", "json");
    return ProjectRepoMappingSchema.parse(data);
  } catch (e) {
    log.debug("kv.get_project_repo_mapping_failed", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return {};
}

export async function getTriggerConfig(env: Env): Promise<TriggerConfig> {
  try {
    const data = await env.LINEAR_KV.get("config:triggers", "json");
    const parsed = TriggerConfigSchema.partial().parse(data);
    return { ...DEFAULT_TRIGGER_CONFIG, ...parsed };
  } catch (e) {
    log.debug("kv.get_trigger_config_failed", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return DEFAULT_TRIGGER_CONFIG;
}

export async function getUserPreferences(
  env: Env,
  userId: string
): Promise<UserPreferences | null> {
  try {
    const data = await env.LINEAR_KV.get(`user_prefs:${userId}`, "json");
    if (!data) return null;
    return UserPreferencesSchema.parse(data);
  } catch (e) {
    log.debug("kv.get_user_preferences_failed", {
      userId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return null;
}

function getIssueSessionKey(issueId: string): string {
  return `issue:${issueId}`;
}

export async function lookupIssueSession(env: Env, issueId: string): Promise<IssueSession | null> {
  try {
    const data = await env.LINEAR_KV.get(getIssueSessionKey(issueId), "json");
    if (!data) return null;
    return IssueSessionSchema.parse(data);
  } catch (e) {
    log.debug("kv.lookup_issue_session_failed", {
      issueId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return null;
}

export async function storeIssueSession(
  env: Env,
  issueId: string,
  session: IssueSession
): Promise<void> {
  await env.LINEAR_KV.put(getIssueSessionKey(issueId), JSON.stringify(session), {
    expirationTtl: 86400 * 7,
  });
}

// ─── Pending classification (elicitation flow) ──────────────────────────────

export interface PendingClassification {
  agentSessionId: string;
  issueId: string;
  issueIdentifier: string;
  issueTitle: string;
  issueDescription?: string | null;
  issueUrl: string;
  labels: string[];
  projectName?: string | null;
  organizationId: string;
  appUserId?: string;
  createdAt: number;
}

export async function storePendingClassification(
  env: Env,
  issueId: string,
  pending: PendingClassification
): Promise<void> {
  await env.LINEAR_KV.put(`pending-classification:${issueId}`, JSON.stringify(pending), {
    expirationTtl: 3600, // 1 hour TTL
  });
}

export async function lookupPendingClassification(
  env: Env,
  issueId: string
): Promise<PendingClassification | null> {
  try {
    const data = await env.LINEAR_KV.get(`pending-classification:${issueId}`, "json");
    if (!data) return null;
    return PendingClassificationSchema.parse(data);
  } catch {
    /* ignore */
  }
  return null;
}

export async function deletePendingClassification(env: Env, issueId: string): Promise<void> {
  await env.LINEAR_KV.delete(`pending-classification:${issueId}`);
}

/**
 * Check if an event has already been processed (deduplication).
 */
export async function isDuplicateEvent(env: Env, eventKey: string): Promise<boolean> {
  const existing = await env.LINEAR_KV.get(`event:${eventKey}`);
  if (existing) return true;
  await env.LINEAR_KV.put(`event:${eventKey}`, "1", { expirationTtl: 3600 });
  return false;
}
