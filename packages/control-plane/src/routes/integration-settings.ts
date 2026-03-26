/**
 * Integration-settings routes and handlers.
 */

import {
  isValidReasoningEffort,
  type GitHubBotSettings,
  type IntegrationId,
  type LinearBotSettings,
} from "@open-inspect/shared";
import {
  IntegrationSettingsStore,
  IntegrationSettingsValidationError,
  isValidIntegrationId,
} from "../db/integration-settings";
import { RepoMappingStore } from "../db/repo-mappings";
import type { Env } from "../types";
import { createLogger } from "../logger";
import { type Route, type RequestContext, parsePattern, json, error } from "./shared";
import { generateInternalToken } from "../auth/internal";

const logger = createLogger("router:integration-settings");

function extractIntegrationId(match: RegExpMatchArray): IntegrationId | null {
  const id = match.groups?.id;
  if (!id || !isValidIntegrationId(id)) return null;
  return id;
}

async function handleGetIntegrationSettings(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const id = extractIntegrationId(match);
  if (!id) return error(`Unknown integration: ${match.groups?.id}`, 404);

  if (!env.DB) {
    return json({ integrationId: id, settings: null });
  }

  const store = new IntegrationSettingsStore(env.DB);
  const settings = await store.getGlobal(id);
  return json({ integrationId: id, settings });
}

async function handleSetIntegrationSettings(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const id = extractIntegrationId(match);
  if (!id) return error(`Unknown integration: ${match.groups?.id}`, 404);

  if (!env.DB) {
    return error("Integration settings storage is not configured", 503);
  }

  let body: { settings?: Record<string, unknown> };
  try {
    body = (await request.json()) as { settings?: Record<string, unknown> };
  } catch {
    return error("Invalid JSON body", 400);
  }

  if (!body?.settings || typeof body.settings !== "object") {
    return error("Request body must include settings object", 400);
  }

  const store = new IntegrationSettingsStore(env.DB);

  try {
    await store.setGlobal(id, body.settings);

    logger.info("integration_settings.updated", {
      event: "integration_settings.updated",
      integration_id: id,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({ status: "updated", integrationId: id });
  } catch (e) {
    if (e instanceof IntegrationSettingsValidationError) {
      return error(e.message, 400);
    }
    logger.error("Failed to update integration settings", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Integration settings storage unavailable", 503);
  }
}

async function handleDeleteIntegrationSettings(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const id = extractIntegrationId(match);
  if (!id) return error(`Unknown integration: ${match.groups?.id}`, 404);

  if (!env.DB) {
    return error("Integration settings storage is not configured", 503);
  }

  const store = new IntegrationSettingsStore(env.DB);

  try {
    await store.deleteGlobal(id);

    logger.info("integration_settings.deleted", {
      event: "integration_settings.deleted",
      integration_id: id,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({ status: "deleted", integrationId: id });
  } catch (e) {
    logger.error("Failed to delete integration settings", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Integration settings storage unavailable", 503);
  }
}

async function handleListRepoSettings(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const id = extractIntegrationId(match);
  if (!id) return error(`Unknown integration: ${match.groups?.id}`, 404);

  if (!env.DB) {
    return json({ integrationId: id, repos: [] });
  }

  const store = new IntegrationSettingsStore(env.DB);
  const repos = await store.listRepoSettings(id);
  return json({ integrationId: id, repos });
}

async function handleGetRepoSettings(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const id = extractIntegrationId(match);
  if (!id) return error(`Unknown integration: ${match.groups?.id}`, 404);

  const owner = match.groups?.owner;
  const name = match.groups?.name;
  if (!owner || !name) return error("Owner and name are required", 400);

  const repo = `${owner}/${name}`;

  if (!env.DB) {
    return json({ integrationId: id, repo, settings: null });
  }

  const store = new IntegrationSettingsStore(env.DB);
  const settings = await store.getRepoSettings(id, repo);
  return json({ integrationId: id, repo, settings });
}

async function handleSetRepoSettings(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const id = extractIntegrationId(match);
  if (!id) return error(`Unknown integration: ${match.groups?.id}`, 404);

  const owner = match.groups?.owner;
  const name = match.groups?.name;
  if (!owner || !name) return error("Owner and name are required", 400);

  if (!env.DB) {
    return error("Integration settings storage is not configured", 503);
  }

  let body: { settings?: Record<string, unknown> };
  try {
    body = (await request.json()) as { settings?: Record<string, unknown> };
  } catch {
    return error("Invalid JSON body", 400);
  }

  if (!body?.settings || typeof body.settings !== "object") {
    return error("Request body must include settings object", 400);
  }

  const store = new IntegrationSettingsStore(env.DB);
  const repo = `${owner}/${name}`;

  try {
    await store.setRepoSettings(id, repo, body.settings);

    logger.info("integration_repo_settings.updated", {
      event: "integration_repo_settings.updated",
      integration_id: id,
      repo,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({ status: "updated", integrationId: id, repo });
  } catch (e) {
    if (e instanceof IntegrationSettingsValidationError) {
      return error(e.message, 400);
    }
    logger.error("Failed to update repo integration settings", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Integration settings storage unavailable", 503);
  }
}

async function handleDeleteRepoSettings(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const id = extractIntegrationId(match);
  if (!id) return error(`Unknown integration: ${match.groups?.id}`, 404);

  const owner = match.groups?.owner;
  const name = match.groups?.name;
  if (!owner || !name) return error("Owner and name are required", 400);

  if (!env.DB) {
    return error("Integration settings storage is not configured", 503);
  }

  const store = new IntegrationSettingsStore(env.DB);
  const repo = `${owner}/${name}`;

  try {
    await store.deleteRepoSettings(id, repo);

    logger.info("integration_repo_settings.deleted", {
      event: "integration_repo_settings.deleted",
      integration_id: id,
      repo,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({ status: "deleted", integrationId: id, repo });
  } catch (e) {
    logger.error("Failed to delete repo integration settings", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Integration settings storage unavailable", 503);
  }
}

async function handleGetResolvedConfig(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const id = extractIntegrationId(match);
  if (!id) return error(`Unknown integration: ${match.groups?.id}`, 404);

  const owner = match.groups?.owner;
  const name = match.groups?.name;
  if (!owner || !name) return error("Owner and name are required", 400);

  if (!env.DB) {
    return json({ integrationId: id, repo: `${owner}/${name}`, config: null });
  }

  const store = new IntegrationSettingsStore(env.DB);
  const repo = `${owner}/${name}`;
  const { enabledRepos, settings } = await store.getResolvedConfig(id, repo);

  if (id === "github") {
    const githubSettings = settings as GitHubBotSettings;
    const reasoningEffort =
      githubSettings.model &&
      githubSettings.reasoningEffort &&
      !isValidReasoningEffort(githubSettings.model, githubSettings.reasoningEffort)
        ? null
        : (githubSettings.reasoningEffort ?? null);

    return json({
      integrationId: id,
      repo,
      config: {
        model: githubSettings.model ?? null,
        reasoningEffort,
        autoReviewOnOpen: githubSettings.autoReviewOnOpen ?? true,
        enabledRepos,
        allowedTriggerUsers: githubSettings.allowedTriggerUsers ?? null,
        codeReviewInstructions: githubSettings.codeReviewInstructions ?? null,
        commentActionInstructions: githubSettings.commentActionInstructions ?? null,
      },
    });
  }

  if (id === "linear") {
    const linearSettings = settings as LinearBotSettings;
    const linearReasoningEffort =
      linearSettings.model &&
      linearSettings.reasoningEffort &&
      !isValidReasoningEffort(linearSettings.model, linearSettings.reasoningEffort)
        ? null
        : (linearSettings.reasoningEffort ?? null);

    return json({
      integrationId: id,
      repo,
      config: {
        model: linearSettings.model ?? null,
        reasoningEffort: linearReasoningEffort,
        allowUserPreferenceOverride: linearSettings.allowUserPreferenceOverride ?? true,
        allowLabelModelOverride: linearSettings.allowLabelModelOverride ?? true,
        emitToolProgressActivities: linearSettings.emitToolProgressActivities ?? true,
        enabledRepos,
      },
    });
  }

  return error(`Unsupported integration: ${id}`, 400);
}

// ─── Repo Mapping Handlers ────────────────────────────────────────────────────

async function handleListRepoMappings(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const id = extractIntegrationId(match);
  if (!id) return error(`Unknown integration: ${match.groups?.id}`, 404);

  if (!env.DB) {
    return json({ integrationId: id, mappings: [] });
  }

  const store = new RepoMappingStore(env.DB);
  const mappings = await store.list(id);
  return json({ integrationId: id, mappings });
}

async function handleCreateRepoMapping(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const id = extractIntegrationId(match);
  if (!id) return error(`Unknown integration: ${match.groups?.id}`, 404);

  if (!env.DB) {
    return error("Repo mapping storage is not configured", 503);
  }

  let body: {
    source_type?: unknown;
    source_id?: unknown;
    source_name?: unknown;
    repo_owner?: unknown;
    repo_name?: unknown;
    label_filter?: unknown;
    is_default?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return error("Invalid JSON body", 400);
  }

  if (body.source_type !== "team" && body.source_type !== "project") {
    return error("source_type must be 'team' or 'project'", 400);
  }
  if (typeof body.source_id !== "string" || !body.source_id) {
    return error("source_id is required", 400);
  }
  if (typeof body.source_name !== "string" || !body.source_name) {
    return error("source_name is required", 400);
  }
  if (typeof body.repo_owner !== "string" || !body.repo_owner) {
    return error("repo_owner is required", 400);
  }
  if (typeof body.repo_name !== "string" || !body.repo_name) {
    return error("repo_name is required", 400);
  }

  const store = new RepoMappingStore(env.DB);

  try {
    const mapping = await store.create({
      integration_id: id,
      source_type: body.source_type,
      source_id: body.source_id,
      source_name: body.source_name,
      repo_owner: body.repo_owner,
      repo_name: body.repo_name,
      label_filter: typeof body.label_filter === "string" ? body.label_filter || null : null,
      is_default: body.is_default === true,
    });

    logger.info("repo_mapping.created", {
      event: "repo_mapping.created",
      integration_id: id,
      mapping_id: mapping.id,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({ mapping }, 201);
  } catch (e) {
    if (e instanceof Error && e.message.includes("UNIQUE")) {
      return error("A mapping for this source and repository already exists", 409);
    }
    logger.error("Failed to create repo mapping", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Failed to create repo mapping", 500);
  }
}

async function handleUpdateRepoMapping(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const id = extractIntegrationId(match);
  if (!id) return error(`Unknown integration: ${match.groups?.id}`, 404);

  const mappingIdStr = match.groups?.mappingId;
  const mappingId = mappingIdStr ? parseInt(mappingIdStr, 10) : NaN;
  if (isNaN(mappingId)) return error("Invalid mapping ID", 400);

  if (!env.DB) {
    return error("Repo mapping storage is not configured", 503);
  }

  let body: {
    source_name?: unknown;
    repo_owner?: unknown;
    repo_name?: unknown;
    label_filter?: unknown;
    is_default?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return error("Invalid JSON body", 400);
  }

  const store = new RepoMappingStore(env.DB);

  try {
    const mapping = await store.update(id, mappingId, {
      source_name: typeof body.source_name === "string" ? body.source_name : undefined,
      repo_owner: typeof body.repo_owner === "string" ? body.repo_owner : undefined,
      repo_name: typeof body.repo_name === "string" ? body.repo_name : undefined,
      label_filter:
        body.label_filter !== undefined
          ? typeof body.label_filter === "string"
            ? body.label_filter || null
            : null
          : undefined,
      is_default: typeof body.is_default === "boolean" ? body.is_default : undefined,
    });

    if (!mapping) {
      return error("Repo mapping not found", 404);
    }

    logger.info("repo_mapping.updated", {
      event: "repo_mapping.updated",
      integration_id: id,
      mapping_id: mappingId,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({ mapping });
  } catch (e) {
    logger.error("Failed to update repo mapping", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Failed to update repo mapping", 500);
  }
}

async function handleDeleteRepoMapping(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const id = extractIntegrationId(match);
  if (!id) return error(`Unknown integration: ${match.groups?.id}`, 404);

  const mappingIdStr = match.groups?.mappingId;
  const mappingId = mappingIdStr ? parseInt(mappingIdStr, 10) : NaN;
  if (isNaN(mappingId)) return error("Invalid mapping ID", 400);

  if (!env.DB) {
    return error("Repo mapping storage is not configured", 503);
  }

  const store = new RepoMappingStore(env.DB);
  const deleted = await store.delete(id, mappingId);

  if (!deleted) {
    return error("Repo mapping not found", 404);
  }

  logger.info("repo_mapping.deleted", {
    event: "repo_mapping.deleted",
    integration_id: id,
    mapping_id: mappingId,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });

  return json({ status: "deleted", mappingId });
}

async function handleResolveRepoMapping(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const id = extractIntegrationId(match);
  if (!id) return error(`Unknown integration: ${match.groups?.id}`, 404);

  if (!env.DB) {
    return json({ integrationId: id, repo: null, reasoning: "No DB configured" });
  }

  const url = new URL(request.url);
  const teamId = url.searchParams.get("teamId") || null;
  const projectId = url.searchParams.get("projectId") || null;
  const labelsParam = url.searchParams.get("labels");
  const labels = labelsParam ? labelsParam.split(",").filter(Boolean) : [];

  const store = new RepoMappingStore(env.DB);
  const resolved = await store.resolve(id, { teamId, projectId, labels });

  return json({ integrationId: id, repo: resolved });
}

// ─── Linear Teams/Projects Proxy ─────────────────────────────────────────────

async function handleLinearTeams(
  _request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!env.LINEAR_BOT) {
    return json({ teams: [] });
  }

  if (!env.INTERNAL_CALLBACK_SECRET) {
    return error("Internal auth not configured", 500);
  }

  const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET);

  let response: Response;
  try {
    response = await env.LINEAR_BOT.fetch("https://internal/config/teams", {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (e) {
    logger.error("Failed to fetch Linear teams from bot", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Failed to fetch Linear teams", 502);
  }

  if (!response.ok) {
    return json({ teams: [] });
  }

  const data = await response.json();
  return json(data);
}

async function handleLinearProjects(
  _request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!env.LINEAR_BOT) {
    return json({ projects: [] });
  }

  if (!env.INTERNAL_CALLBACK_SECRET) {
    return error("Internal auth not configured", 500);
  }

  const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET);

  let response: Response;
  try {
    response = await env.LINEAR_BOT.fetch("https://internal/config/projects", {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (e) {
    logger.error("Failed to fetch Linear projects from bot", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Failed to fetch Linear projects", 502);
  }

  if (!response.ok) {
    return json({ projects: [] });
  }

  const data = await response.json();
  return json(data);
}

export const integrationSettingsRoutes: Route[] = [
  // Integration settings — global
  {
    method: "GET",
    pattern: parsePattern("/integration-settings/:id"),
    handler: handleGetIntegrationSettings,
  },
  {
    method: "PUT",
    pattern: parsePattern("/integration-settings/:id"),
    handler: handleSetIntegrationSettings,
  },
  {
    method: "DELETE",
    pattern: parsePattern("/integration-settings/:id"),
    handler: handleDeleteIntegrationSettings,
  },
  // Integration settings — per-repo
  {
    method: "GET",
    pattern: parsePattern("/integration-settings/:id/repos"),
    handler: handleListRepoSettings,
  },
  {
    method: "GET",
    pattern: parsePattern("/integration-settings/:id/repos/:owner/:name"),
    handler: handleGetRepoSettings,
  },
  {
    method: "PUT",
    pattern: parsePattern("/integration-settings/:id/repos/:owner/:name"),
    handler: handleSetRepoSettings,
  },
  {
    method: "DELETE",
    pattern: parsePattern("/integration-settings/:id/repos/:owner/:name"),
    handler: handleDeleteRepoSettings,
  },
  // Resolved config — used by bots at runtime
  {
    method: "GET",
    pattern: parsePattern("/integration-settings/:id/resolved/:owner/:name"),
    handler: handleGetResolvedConfig,
  },

  // Linear teams/projects proxy (must come before generic :id routes that could conflict)
  {
    method: "GET",
    pattern: parsePattern("/integration-settings/linear/teams"),
    handler: handleLinearTeams,
  },
  {
    method: "GET",
    pattern: parsePattern("/integration-settings/linear/projects"),
    handler: handleLinearProjects,
  },

  // Repo mappings — CRUD + resolve (resolve must come before :mappingId)
  {
    method: "GET",
    pattern: parsePattern("/integration-settings/:id/repo-mappings"),
    handler: handleListRepoMappings,
  },
  {
    method: "POST",
    pattern: parsePattern("/integration-settings/:id/repo-mappings"),
    handler: handleCreateRepoMapping,
  },
  {
    method: "GET",
    pattern: parsePattern("/integration-settings/:id/repo-mappings/resolve"),
    handler: handleResolveRepoMapping,
  },
  {
    method: "PUT",
    pattern: parsePattern("/integration-settings/:id/repo-mappings/:mappingId"),
    handler: handleUpdateRepoMapping,
  },
  {
    method: "DELETE",
    pattern: parsePattern("/integration-settings/:id/repo-mappings/:mappingId"),
    handler: handleDeleteRepoMapping,
  },
];
