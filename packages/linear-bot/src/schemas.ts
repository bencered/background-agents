/**
 * Zod schemas for linear-bot internal types.
 * Used to validate KV reads, API responses, and callback payloads at runtime.
 */
import { z } from "zod";

// Re-export webhook schema from shared
export { AgentSessionWebhookSchema } from "@open-inspect/shared";

// ─── KV Schemas ──────────────────────────────────────────────────────────────

const StaticRepoConfigSchema = z.object({
  owner: z.string(),
  name: z.string(),
  label: z.string().optional(),
});

export const TeamRepoMappingSchema = z.record(z.string(), z.array(StaticRepoConfigSchema));

export const ProjectRepoMappingSchema = z.record(
  z.string(),
  z.object({ owner: z.string(), name: z.string() })
);

export const TriggerConfigSchema = z.object({
  triggerLabel: z.string(),
  triggerAssignee: z.string().optional(),
  autoTriggerOnCreate: z.boolean(),
  triggerCommand: z.string().optional(),
});

export const UserPreferencesSchema = z.object({
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  emitToolProgressActivities: z.boolean().optional(),
});

export const IssueSessionSchema = z.object({
  sessionId: z.string(),
  issueId: z.string(),
  issueIdentifier: z.string(),
  repoOwner: z.string(),
  repoName: z.string(),
  model: z.string(),
  agentSessionId: z.string().optional(),
  createdAt: z.number(),
});

export const PendingClassificationSchema = z.object({
  agentSessionId: z.string(),
  issueId: z.string(),
  issueIdentifier: z.string(),
  issueTitle: z.string(),
  issueDescription: z.string().nullable().optional(),
  issueUrl: z.string(),
  labels: z.array(z.string()),
  projectName: z.string().nullable().optional(),
  organizationId: z.string(),
  appUserId: z.string().optional(),
  createdAt: z.number(),
});

// ─── Callback Schemas ────────────────────────────────────────────────────────

const LinearCallbackContextSchema = z.object({
  issueId: z.string(),
  issueIdentifier: z.string().optional(),
  agentSessionId: z.string().optional(),
  organizationId: z.string().optional(),
  emitToolProgressActivities: z.boolean().optional(),
});

export const CompletionCallbackSchema = z.object({
  sessionId: z.string(),
  messageId: z.string(),
  success: z.boolean(),
  timestamp: z.number(),
  signature: z.string(),
  context: LinearCallbackContextSchema,
});

export const ToolCallCallbackSchema = z.object({
  sessionId: z.string(),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()).default({}),
  callId: z.string().optional(),
  status: z.string().optional(),
  timestamp: z.number(),
  signature: z.string(),
  context: LinearCallbackContextSchema,
});

export const ToolResultCallbackSchema = z.object({
  sessionId: z.string(),
  tool: z.string(),
  callId: z.string().optional(),
  result: z.string().default(""),
  isError: z.boolean().default(false),
  timestamp: z.number(),
  signature: z.string(),
  context: LinearCallbackContextSchema,
});

// ─── Control Plane API Schemas ───────────────────────────────────────────────

/** Matches shared EnrichedRepository (InstallationRepository + metadata). */
const ControlPlaneRepoSchema = z.object({
  id: z.number(),
  owner: z.string(),
  name: z.string(),
  fullName: z.string(),
  description: z.string().nullable(),
  private: z.boolean(),
  defaultBranch: z.string(),
  metadata: z
    .object({
      description: z.string().optional(),
      aliases: z.array(z.string()).optional(),
      channelAssociations: z.array(z.string()).optional(),
      keywords: z.array(z.string()).optional(),
    })
    .optional(),
});

export const ControlPlaneReposResponseSchema = z.object({
  repos: z.array(ControlPlaneRepoSchema),
  cached: z.boolean().optional(),
  cachedAt: z.string().optional(),
});

// ─── Event / Artifact Schemas ────────────────────────────────────────────────

export const EventResponseSchema = z.object({
  id: z.string(),
  type: z.string(),
  createdAt: z.number().or(z.string()),
  data: z.record(z.string(), z.unknown()),
});

export const ListEventsResponseSchema = z.object({
  events: z.array(EventResponseSchema),
  hasMore: z.boolean().optional(),
  cursor: z.string().optional(),
});

const ArtifactTypeSchema = z.enum(["pr", "screenshot", "preview", "branch"]);

export const ArtifactResponseSchema = z.object({
  type: ArtifactTypeSchema,
  url: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

export const ListArtifactsResponseSchema = z.object({
  artifacts: z.array(ArtifactResponseSchema),
});

// ─── OAuth Schemas ───────────────────────────────────────────────────────────

export const OAuthTokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.string(),
  expires_in: z.number(),
  refresh_token: z.string(),
  scope: z.string().optional(),
});

export const StoredTokenDataSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_at: z.number(),
});

// ─── Repo Cache Schema ───────────────────────────────────────────────────────

/** Matches shared RepoConfig (used for KV cache reads). */
export const RepoConfigSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  owner: z.string(),
  name: z.string(),
  fullName: z.string(),
  displayName: z.string().optional(),
  description: z.string().nullable().optional(),
  defaultBranch: z.string(),
  private: z.boolean(),
  aliases: z.array(z.string()).optional(),
  keywords: z.array(z.string()).optional(),
  channelAssociations: z.array(z.string()).optional(),
});

export const RepoConfigArraySchema = z.array(RepoConfigSchema);
