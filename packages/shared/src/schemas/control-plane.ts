/**
 * Zod schemas for control plane API responses.
 * Used by all bot packages to validate responses at runtime.
 */
import { z } from "zod";

// ─── Session ─────────────────────────────────────────────────────────────────

export const SessionStatusSchema = z.enum([
  "created",
  "active",
  "completed",
  "failed",
  "archived",
  "cancelled",
]);

export const CreateSessionResponseSchema = z.object({
  sessionId: z.string(),
  status: SessionStatusSchema.optional(),
});

export const GetSessionResponseSchema = z.object({
  status: SessionStatusSchema,
});

export const SendPromptResponseSchema = z.object({
  messageId: z.string(),
});

export const SessionEventsResponseSchema = z.object({
  events: z.array(
    z.object({
      type: z.string(),
      data: z.record(z.string(), z.unknown()),
    })
  ),
});

// ─── Repos ───────────────────────────────────────────────────────────────────

export const EnabledModelsResponseSchema = z.object({
  enabledModels: z.array(z.string()),
});

// ─── Integration Config ──────────────────────────────────────────────────────

export const IntegrationConfigResponseSchema = z.object({
  config: z
    .object({
      model: z.string().nullable(),
      maxConcurrentSessions: z.number().optional(),
      emitToolProgressActivities: z.boolean().optional(),
    })
    .nullable(),
});

// ─── GitHub Auth ─────────────────────────────────────────────────────────────

export const GitHubTokenResponseSchema = z.object({
  token: z.string(),
});

export const GitHubPermissionResponseSchema = z.object({
  permission: z.string(),
});
