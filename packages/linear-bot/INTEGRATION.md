# Linear Agent Integration with Control Plane

## ⚠️ CRITICAL: READ THE LINEAR DOCS FIRST

**Before making ANY changes to this package, read the Linear Agents API docs:**

- https://linear.app/developers/agent-interaction
- https://linear.app/developers/agent-signals
- https://linear.app/developers/agent-best-practices
- https://linear.app/developers/agents

**No exceptions. No guessing. No assumptions about webhook payload shapes.**

### Key Webhook Payload Rules (from docs)

- `created` action → original comment in `agentSession.comment.body`, context in `promptContext`
- `prompted` action → user's follow-up reply in `agentActivity.body` (NOT comment.body)
- `previousComments` and `guidance` fields provide additional context
- Session states: `pending`, `active`, `error`, `awaitingInput`, `complete`
- Must respond within 5 seconds of webhook receipt
- Must send activity or update externalUrl within 10 seconds of `created` event

---

The Linear agent requires changes to the control plane to support callback routing.

## Control Plane Changes

### 1. Add `LINEAR_BOT` service binding to `Env` (types.ts)

```typescript
LINEAR_BOT?: Fetcher; // Optional - only if linear-bot is deployed
```

### 2. Add `"linear"` to `MessageSource` (types.ts)

```typescript
export type MessageSource = "web" | "slack" | "linear" | "extension" | "github";
```

### 3. Generic callback routing (durable-object.ts)

The `notifyCallbackClient()` method routes based on the `source` field of the message:

- `"linear"` → `LINEAR_BOT` service binding
- `"slack"` → `SLACK_BOT` service binding
- default → `SLACK_BOT` (backward compat)

### 4. Relaxed `callbackContext` type (durable-object.ts)

Changed from Slack-specific interface to `Record<string, unknown>` so any integration can pass its
own context (e.g. `agentSessionId` for Linear agent activities).

### 5. Repository query includes `source` (repository.ts)

`getMessageCallbackContext()` now returns `{ callback_context, source }` for routing.

## Linear Agent Architecture

### Authentication

- OAuth2 with `actor=app` — agent gets its own identity per workspace
- Tokens stored in KV with auto-refresh (`oauth:token:{orgId}`)
- No personal API key needed

### Agent Session Lifecycle

1. User @mentions or assigns the agent → Linear sends `AgentSessionEvent`
2. Agent emits `Thought` activities (visible as "thinking" in Linear)
3. Agent creates Open-Inspect session and sends prompt
4. Agent emits `Response` with session link
5. On completion callback, agent emits `Response` with PR link

### Callback Context

The `callbackContext` includes `agentSessionId` and `organizationId` so the completion callback can
emit `AgentActivity` on the correct session.

## Terraform Variables

| Variable                | Description                     |
| ----------------------- | ------------------------------- |
| `linear_client_id`      | OAuth Application Client ID     |
| `linear_client_secret`  | OAuth Application Client Secret |
| `linear_webhook_secret` | Webhook Signing Secret          |

The old `linear_api_key` variable is no longer required but kept for backward compatibility in the
tfvars example.
