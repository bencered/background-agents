/**
 * Zod schemas for Linear GraphQL API responses.
 * Used by the linear bot to validate API responses at runtime.
 */
import { z } from "zod";

// ─── Agent Session Webhook ───────────────────────────────────────────────────

const AgentActivityContentSchema = z.object({
  type: z.string(),
  body: z.string().optional(),
});

const WebhookAgentActivitySchema = z.object({
  id: z.string(),
  agentSessionId: z.string(),
  content: AgentActivityContentSchema,
  signal: z.string().nullable().optional(),
  signalMetadata: z.record(z.string(), z.unknown()).nullable().optional(),
  userId: z.string().nullable().optional(),
  user: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string().optional(),
  }).optional(),
});

const WebhookCommentSchema = z.object({
  id: z.string(),
  body: z.string(),
  userId: z.string().optional(),
  issueId: z.string().optional(),
});

const WebhookIssueSchema = z.object({
  id: z.string(),
  title: z.string(),
  identifier: z.string(),
  url: z.string(),
  description: z.string().nullable().optional(),
  teamId: z.string().optional(),
  team: z.object({
    id: z.string(),
    key: z.string(),
    name: z.string(),
  }).optional(),
});

const WebhookAgentSessionSchema = z.object({
  id: z.string(),
  status: z.string(),
  commentId: z.string().nullable().optional(),
  issueId: z.string(),
  comment: WebhookCommentSchema.nullable().optional(),
  issue: WebhookIssueSchema,
  creator: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string().optional(),
  }).optional(),
});

export const AgentSessionWebhookSchema = z.object({
  type: z.literal("AgentSessionEvent"),
  action: z.string(),
  organizationId: z.string(),
  agentSession: WebhookAgentSessionSchema,
  agentActivity: WebhookAgentActivitySchema.optional(),
  promptContext: z.string().optional(),
  previousComments: z.array(z.unknown()).optional(),
  guidance: z.string().nullable().optional(),
  webhookTimestamp: z.number().optional(),
  webhookId: z.string().optional(),
});

/** Parsed type for the agent session webhook payload. */
export type AgentSessionWebhook = z.infer<typeof AgentSessionWebhookSchema>;

// ─── Common ──────────────────────────────────────────────────────────────────

const LinearLabelSchema = z.object({
  id: z.string(),
  name: z.string(),
});

const LinearProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
});

const LinearAssigneeSchema = z.object({
  id: z.string(),
  name: z.string(),
});

const LinearTeamSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
});

const LinearCommentSchema = z.object({
  body: z.string(),
  user: z.object({ name: z.string() }).optional(),
});

// ─── Team Started State ──────────────────────────────────────────────────────

const WorkflowStateNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  position: z.number(),
});

export const TeamStartedStatesResponseSchema = z.object({
  data: z.object({
    team: z.object({
      states: z.object({
        nodes: z.array(WorkflowStateNodeSchema),
      }),
    }).nullable().optional(),
  }).optional(),
});

// ─── Issue Update ────────────────────────────────────────────────────────────

export const IssueUpdateResponseSchema = z.object({
  data: z.object({
    issueUpdate: z.object({
      success: z.boolean(),
    }).optional(),
  }).optional(),
});

// ─── Viewer ──────────────────────────────────────────────────────────────────

export const ViewerResponseSchema = z.object({
  data: z.object({
    viewer: z.object({
      id: z.string(),
    }).optional(),
  }).optional(),
});

// ─── Issue Details ───────────────────────────────────────────────────────────

export const IssueDetailsResponseSchema = z.object({
  data: z.object({
    issue: z.object({
      id: z.string(),
      identifier: z.string(),
      title: z.string(),
      description: z.string().nullable().optional(),
      url: z.string(),
      priority: z.number(),
      priorityLabel: z.string(),
      labels: z.object({ nodes: z.array(LinearLabelSchema) }),
      project: LinearProjectSchema.nullable(),
      assignee: LinearAssigneeSchema.nullable(),
      team: LinearTeamSchema,
      comments: z.object({ nodes: z.array(LinearCommentSchema) }),
    }).nullable().optional(),
  }).optional(),
});

// ─── Repo Suggestions ────────────────────────────────────────────────────────

export const RepoSuggestionsResponseSchema = z.object({
  data: z.object({
    issueRepositorySuggestions: z.object({
      suggestions: z.array(
        z.object({
          hostname: z.string().optional(),
          repositoryFullName: z.string(),
          confidence: z.number(),
        })
      ),
    }).optional(),
  }).optional(),
});

// ─── Comment Create ──────────────────────────────────────────────────────────

export const CommentCreateResponseSchema = z.object({
  data: z.object({
    commentCreate: z.object({
      success: z.boolean(),
    }).optional(),
  }).optional(),
});

// ─── Workspace Info ──────────────────────────────────────────────────────────

export const WorkspaceInfoResponseSchema = z.object({
  data: z.object({
    viewer: z.object({
      organization: z.object({
        id: z.string(),
        name: z.string(),
      }).optional(),
    }).optional(),
  }).optional(),
});
