/**
 * Utility to resolve project/team → repo mapping via the control plane D1 API.
 * Replaces the legacy KV-based getTeamRepoMapping / getProjectRepoMapping lookups.
 */

import type { Env } from "../types";
import { generateInternalToken } from "./internal";
import { createLogger } from "../logger";

const log = createLogger("repo-mapping");

export interface ResolvedRepoMapping {
  owner: string;
  name: string;
  reasoning: string;
}

/**
 * Resolve the best repo for an issue from the D1 repo_mappings table.
 * Returns null if no mapping is configured or the control plane is unavailable.
 */
export async function resolveRepoFromMappings(
  env: Env,
  opts: {
    teamId?: string | null;
    projectId?: string | null;
    labels?: string[];
  }
): Promise<ResolvedRepoMapping | null> {
  if (!env.INTERNAL_CALLBACK_SECRET) {
    return null;
  }

  const params = new URLSearchParams();
  if (opts.teamId) params.set("teamId", opts.teamId);
  if (opts.projectId) params.set("projectId", opts.projectId);
  if (opts.labels && opts.labels.length > 0) params.set("labels", opts.labels.join(","));

  const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET);

  let response: Response | undefined;
  try {
    response = await env.CONTROL_PLANE.fetch(
      `https://internal/integration-settings/linear/repo-mappings/resolve?${params.toString()}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
  } catch (e) {
    log.debug("resolve_repo_mapping.fetch_failed", {
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }

  if (!response || !response.ok) {
    log.debug("resolve_repo_mapping.non_ok", { status: response?.status });
    return null;
  }

  const data = (await response.json()) as { repo: ResolvedRepoMapping | null };
  return data.repo ?? null;
}
