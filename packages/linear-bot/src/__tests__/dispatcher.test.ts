/**
 * Tests for the dispatcher logic in handleAgentSessionEvent.
 * These test the routing decisions, not the full handler execution.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Env, IssueSession } from "../types";

// Test fixtures use `any` type — partial webhook objects
import type { PendingClassification } from "../kv-store";

// Mock all dependencies
vi.mock("../utils/linear-client", () => ({
  getLinearClient: vi.fn().mockResolvedValue({ accessToken: "test" }),
  emitAgentActivity: vi.fn().mockResolvedValue(undefined),
  fetchIssueDetails: vi.fn().mockResolvedValue(null),
  updateAgentSession: vi.fn().mockResolvedValue(undefined),
  getRepoSuggestions: vi.fn().mockResolvedValue([]),
  getTeamStartedState: vi.fn().mockResolvedValue(null),
  updateIssue: vi.fn().mockResolvedValue(true),
  getAppUserId: vi.fn().mockResolvedValue("bot-user-id"),
}));

vi.mock("../utils/internal", () => ({
  generateInternalToken: vi.fn().mockResolvedValue("mock-token"),
}));

vi.mock("../classifier", () => ({
  classifyRepo: vi.fn().mockResolvedValue({
    needsClarification: true,
    repo: null,
    reasoning: "test",
    alternatives: [],
    confidence: 0,
  }),
}));

vi.mock("../classifier/repos", () => ({
  getAvailableRepos: vi.fn().mockResolvedValue([]),
}));

vi.mock("../utils/integration-config", () => ({
  getLinearConfig: vi.fn().mockResolvedValue({
    enabledRepos: null,
    model: null,
    reasoningEffort: undefined,
    allowUserPreferenceOverride: false,
    allowLabelModelOverride: false,
    emitToolProgressActivities: false,
  }),
}));

vi.mock("../model-resolution", () => ({
  resolveStaticRepo: vi.fn().mockReturnValue(null),
  extractModelFromLabels: vi.fn().mockReturnValue(null),
  resolveSessionModelSettings: vi.fn().mockReturnValue({ model: "claude-sonnet-4-6", reasoningEffort: undefined }),
}));

vi.mock("../plan", () => ({
  makePlan: vi.fn().mockReturnValue([]),
}));

// Import mocked modules
const linearClient = await import("../utils/linear-client");
const { handleAgentSessionEvent } = await import("../webhook-handler");

function makeIssue(overrides: Record<string, any> = {}) {
  return {
    id: "issue-1",
    identifier: "ENG-1",
    title: "Test issue",
    description: "Test description",
    url: "https://linear.app/test/issue/ENG-1",
    priority: 1,
    priorityLabel: "Urgent",
    team: { id: "team-1", key: "ENG", name: "Engineering" },
    ...overrides,
  };
}

function makeWebhook(overrides: Record<string, any> = {}): any {
  return {
    type: "AgentSessionEvent",
    action: "created",
    organizationId: "org-1",
    appUserId: "user-1",
    agentSession: {
      id: "agent-session-1",
      issue: makeIssue(),
    },
    ...overrides,
  };
}

// Mock KV
const kvStore = new Map<string, string>();
const mockKV = {
  get: vi.fn((key: string, type?: string) => {
    const raw = kvStore.get(key) ?? null;
    if (raw === null) return Promise.resolve(null);
    if (type === "json") return Promise.resolve(JSON.parse(raw));
    return Promise.resolve(raw);
  }),
  put: vi.fn((key: string, value: string) => {
    kvStore.set(key, value);
    return Promise.resolve();
  }),
  delete: vi.fn((key: string) => {
    kvStore.delete(key);
    return Promise.resolve();
  }),
};

// Mock CONTROL_PLANE service binding
const mockControlPlaneFetch = vi.fn();

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    LINEAR_KV: mockKV as unknown as KVNamespace,
    CONTROL_PLANE: { fetch: mockControlPlaneFetch } as unknown as Fetcher,
    DEPLOYMENT_NAME: "test",
    CONTROL_PLANE_URL: "https://internal",
    WEB_APP_URL: "https://app.test.com",
    DEFAULT_MODEL: "claude-sonnet-4-6",
    LINEAR_CLIENT_ID: "client-id",
    LINEAR_CLIENT_SECRET: "client-secret",
    WORKER_URL: "https://worker.test.com",
    LINEAR_WEBHOOK_SECRET: "webhook-secret",
    ANTHROPIC_API_KEY: "anthropic-key",
    INTERNAL_CALLBACK_SECRET: "internal-secret",
    ...overrides,
  } as Env;
}

function storeSession(issueId: string, session: Partial<IssueSession> = {}) {
  const full: IssueSession = {
    sessionId: "session-abc",
    issueId,
    issueIdentifier: "ENG-1",
    repoOwner: "org",
    repoName: "repo",
    model: "claude-sonnet-4-6",
    agentSessionId: "agent-session-1",
    createdAt: Date.now(),
    ...session,
  };
  kvStore.set(`issue:${issueId}`, JSON.stringify(full));
}

function storePending(issueId: string, pending: Partial<PendingClassification> = {}) {
  const full: PendingClassification = {
    agentSessionId: "agent-session-1",
    issueId,
    issueIdentifier: "ENG-1",
    issueTitle: "Test",
    issueUrl: "https://linear.app/test/issue/ENG-1",
    labels: [],
    organizationId: "org-1",
    createdAt: Date.now(),
    ...pending,
  };
  kvStore.set(`pending-classification:${issueId}`, JSON.stringify(full));
}

beforeEach(() => {
  vi.clearAllMocks();
  kvStore.clear();
  mockControlPlaneFetch.mockReset();
});

describe("handleAgentSessionEvent — dispatcher routing", () => {
  describe("stop signal", () => {
    it("stops active session and clears KV when stop signal received", async () => {
      storeSession("issue-1");
      mockControlPlaneFetch.mockResolvedValueOnce({ ok: true });

      await handleAgentSessionEvent(
        makeWebhook({
          action: "prompted",
          agentActivity: { id: "act-1", agentSessionId: "agent-session-1", content: { type: "prompt", body: "stop" }, signal: "stop" },
        }),
        makeEnv(),
        "trace-1"
      );

      // Should have called stop endpoint
      expect(mockControlPlaneFetch).toHaveBeenCalledWith(
        expect.stringContaining("/sessions/session-abc/stop"),
        expect.objectContaining({ method: "POST" })
      );

      // KV should be cleared
      expect(kvStore.has("issue:issue-1")).toBe(false);

      // Should emit response activity
      expect(linearClient.emitAgentActivity).toHaveBeenCalledWith(
        expect.anything(),
        "agent-session-1",
        expect.objectContaining({ type: "response" })
      );
    });

    it("handles stop signal when no session exists", async () => {
      await handleAgentSessionEvent(
        makeWebhook({
          action: "prompted",
          agentActivity: { id: "act-1", agentSessionId: "agent-session-1", content: { type: "prompt", body: "stop" }, signal: "stop" },
        }),
        makeEnv(),
        "trace-1"
      );

      // Should NOT call control plane stop
      expect(mockControlPlaneFetch).not.toHaveBeenCalled();

      // Should still emit response
      expect(linearClient.emitAgentActivity).toHaveBeenCalledWith(
        expect.anything(),
        "agent-session-1",
        expect.objectContaining({
          type: "response",
          body: expect.stringContaining("No active session"),
        })
      );
    });
  });

  describe("stale session handling", () => {
    it("clears archived session and creates new one", async () => {
      storeSession("issue-1");

      // Session status check returns archived
      mockControlPlaneFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "archived" }),
      });
      // Session creation
      mockControlPlaneFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessionId: "new-session" }),
      });
      // Prompt send
      mockControlPlaneFetch.mockResolvedValueOnce({ ok: true });

      await handleAgentSessionEvent(makeWebhook(), makeEnv(), "trace-1");

      // Should have cleared old session from KV
      expect(mockKV.delete).toHaveBeenCalledWith("issue:issue-1");
    });

    it("routes to follow-up for alive session", async () => {
      storeSession("issue-1");

      // Session status check returns alive
      mockControlPlaneFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "active" }),
      });
      // Events fetch for context
      mockControlPlaneFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ events: [] }),
      });
      // Prompt send
      mockControlPlaneFetch.mockResolvedValueOnce({ ok: true });

      await handleAgentSessionEvent(
        makeWebhook({ action: "prompted", agentActivity: { id: "act-1", agentSessionId: "agent-session-1", content: { type: "prompt", body: "do more" } } }),
        makeEnv(),
        "trace-1"
      );

      // Should emit follow-up response
      expect(linearClient.emitAgentActivity).toHaveBeenCalledWith(
        expect.anything(),
        "agent-session-1",
        expect.objectContaining({
          type: "response",
          body: expect.stringContaining("Follow-up sent"),
        })
      );
    });

    it("clears completed session and creates new one", async () => {
      storeSession("issue-1");

      // Session status check returns completed (terminal)
      mockControlPlaneFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "completed" }),
      });
      // Session creation (after clearing stale)
      mockControlPlaneFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessionId: "new-session" }),
      });
      // Prompt send
      mockControlPlaneFetch.mockResolvedValueOnce({ ok: true });

      await handleAgentSessionEvent(makeWebhook(), makeEnv(), "trace-1");

      expect(mockKV.delete).toHaveBeenCalledWith("issue:issue-1");
    });

    it("assumes alive when control plane is unreachable", async () => {
      storeSession("issue-1");

      // Session status check fails
      mockControlPlaneFetch.mockRejectedValueOnce(new Error("network error"));
      // Events fetch
      mockControlPlaneFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ events: [] }),
      });
      // Prompt send
      mockControlPlaneFetch.mockResolvedValueOnce({ ok: true });

      await handleAgentSessionEvent(
        makeWebhook({ action: "prompted", agentActivity: { id: "act-1", agentSessionId: "agent-session-1", content: { type: "prompt", body: "follow up" } } }),
        makeEnv(),
        "trace-1"
      );

      // Should route to follow-up (assume alive)
      expect(linearClient.emitAgentActivity).toHaveBeenCalledWith(
        expect.anything(),
        "agent-session-1",
        expect.objectContaining({
          type: "response",
          body: expect.stringContaining("Follow-up sent"),
        })
      );
    });
  });

  describe("pending classification", () => {
    it("routes to classification reply when pending exists", async () => {
      storePending("issue-1");

      await handleAgentSessionEvent(
        makeWebhook({
          action: "prompted",
          agentActivity: { id: "act-1", agentSessionId: "agent-session-1", content: { type: "prompt", body: "org/repo-a" } },
        }),
        makeEnv(),
        "trace-1"
      );

      // Should have tried to match the reply as a repo name
      // (handleClassificationReply calls getAvailableRepos)
      const { getAvailableRepos } = await import("../classifier/repos");
      expect(getAvailableRepos).toHaveBeenCalled();
    });
  });

  describe("stop/cancelled action", () => {
    it("handles stopped action", async () => {
      storeSession("issue-1");
      mockControlPlaneFetch.mockResolvedValueOnce({ ok: true });

      await handleAgentSessionEvent(
        makeWebhook({ action: "stopped" }),
        makeEnv(),
        "trace-1"
      );

      expect(mockControlPlaneFetch).toHaveBeenCalledWith(
        expect.stringContaining("/sessions/session-abc/stop"),
        expect.objectContaining({ method: "POST" })
      );
    });

    it("handles cancelled action", async () => {
      storeSession("issue-1");
      mockControlPlaneFetch.mockResolvedValueOnce({ ok: true });

      await handleAgentSessionEvent(
        makeWebhook({ action: "cancelled" }),
        makeEnv(),
        "trace-1"
      );

      expect(mockControlPlaneFetch).toHaveBeenCalledWith(
        expect.stringContaining("/sessions/session-abc/stop"),
        expect.objectContaining({ method: "POST" })
      );
    });
  });

  describe("repo selection — full flow", () => {
    it("shows elicitation with all repos when multiple available", async () => {
      const { getAvailableRepos } = await import("../classifier/repos");
      (getAvailableRepos as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "carboncopyinc/habakkuk", owner: "CarbonCopyInc", name: "habakkuk", fullName: "CarbonCopyInc/habakkuk", displayName: "habakkuk", description: "Main app", defaultBranch: "main", private: true },
        { id: "bencered/dom", owner: "bencered", name: "dom", fullName: "bencered/dom", displayName: "dom", description: "Coding agent", defaultBranch: "main", private: false },
      ]);

      // No session creation — should show elicitation
      await handleAgentSessionEvent(makeWebhook(), makeEnv(), "trace-1");

      // Should emit a response with available repos
      expect(linearClient.emitAgentActivity).toHaveBeenCalledWith(
        expect.anything(),
        "agent-session-1",
        expect.objectContaining({
          type: "response",
          body: expect.stringContaining("habakkuk"),
        })
      );

      // Should have stored pending classification
      expect(kvStore.has("pending-classification:issue-1")).toBe(true);

      // Should NOT have called session creation
      expect(mockControlPlaneFetch).not.toHaveBeenCalledWith(
        expect.stringContaining("/sessions"),
        expect.objectContaining({ method: "POST" })
      );
    });

    it("creates session on correct repo when user replies with repo name", async () => {
      const { getAvailableRepos } = await import("../classifier/repos");
      (getAvailableRepos as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "carboncopyinc/habakkuk", owner: "CarbonCopyInc", name: "habakkuk", fullName: "CarbonCopyInc/habakkuk", displayName: "habakkuk", description: "Main app", defaultBranch: "main", private: true },
        { id: "bencered/dom", owner: "bencered", name: "dom", fullName: "bencered/dom", displayName: "dom", description: "Coding agent", defaultBranch: "main", private: false },
      ]);

      // Store pending classification (simulating first webhook already happened)
      storePending("issue-1");

      // Session creation response
      mockControlPlaneFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessionId: "new-session-123" }),
      });
      // Prompt send response
      mockControlPlaneFetch.mockResolvedValueOnce({ ok: true });

      // User replies "habakkuk"
      await handleAgentSessionEvent(
        makeWebhook({
          action: "prompted",
          agentSession: {
            id: "agent-session-1",
            issue: makeIssue(),
            comment: { body: "habakkuk" },
          },
        }),
        makeEnv(),
        "trace-1"
      );

      // Should have created session with CarbonCopyInc/habakkuk, NOT bencered/dom
      expect(mockControlPlaneFetch).toHaveBeenCalledWith(
        expect.stringContaining("/sessions"),
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining("CarbonCopyInc"),
        })
      );

      // Verify the body contains habakkuk
      const sessionCall = mockControlPlaneFetch.mock.calls.find(
        (c: any) => c[0].includes("/sessions") && c[1]?.method === "POST"
      );
      expect(sessionCall).toBeDefined();
      const body = JSON.parse(sessionCall![1].body as string);
      expect(body.repoOwner).toBe("CarbonCopyInc");
      expect(body.repoName).toBe("habakkuk");

      // Should emit "Working on" with correct repo
      expect(linearClient.emitAgentActivity).toHaveBeenCalledWith(
        expect.anything(),
        "agent-session-1",
        expect.objectContaining({
          type: "response",
          body: expect.stringContaining("CarbonCopyInc/habakkuk"),
        })
      );
    });

    it("does NOT select bencered/dom when user types habakkuk", async () => {
      const { getAvailableRepos } = await import("../classifier/repos");
      (getAvailableRepos as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "carboncopyinc/habakkuk", owner: "CarbonCopyInc", name: "habakkuk", fullName: "CarbonCopyInc/habakkuk", displayName: "habakkuk", description: "Main app", defaultBranch: "main", private: true },
        { id: "bencered/dom", owner: "bencered", name: "dom", fullName: "bencered/dom", displayName: "dom", description: "Coding agent", defaultBranch: "main", private: false },
      ]);

      storePending("issue-1");

      mockControlPlaneFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessionId: "new-session-456" }),
      });
      mockControlPlaneFetch.mockResolvedValueOnce({ ok: true });

      await handleAgentSessionEvent(
        makeWebhook({
          action: "prompted",
          agentSession: {
            id: "agent-session-1",
            issue: makeIssue(),
            comment: { body: "habakkuk" },
          },
        }),
        makeEnv(),
        "trace-1"
      );

      // Should NEVER create a session on bencered/dom
      const sessionCalls = mockControlPlaneFetch.mock.calls.filter(
        (c: any) => c[0].includes("/sessions") && c[1]?.method === "POST"
      );
      for (const call of sessionCalls) {
        const body = JSON.parse(call[1].body as string);
        expect(body.repoOwner).not.toBe("bencered");
        expect(body.repoName).not.toBe("dom");
      }
    });

    it("auto-selects when only one repo available", async () => {
      const { getAvailableRepos } = await import("../classifier/repos");
      (getAvailableRepos as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "bencered/dom", owner: "bencered", name: "dom", fullName: "bencered/dom", displayName: "dom", description: "Coding agent", defaultBranch: "main", private: false },
      ]);

      // Repo mapping resolve (returns no mapping)
      mockControlPlaneFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ repo: null }),
      });
      // Session creation
      mockControlPlaneFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessionId: "auto-session" }),
      });
      // Prompt send
      mockControlPlaneFetch.mockResolvedValueOnce({ ok: true });

      await handleAgentSessionEvent(makeWebhook(), makeEnv(), "trace-1");

      // Should auto-select the only repo
      const sessionCall = mockControlPlaneFetch.mock.calls.find(
        (c: any) => c[0].includes("/sessions") && c[1]?.method === "POST"
      );
      expect(sessionCall).toBeDefined();
      const body = JSON.parse(sessionCall![1].body as string);
      expect(body.repoOwner).toBe("bencered");
      expect(body.repoName).toBe("dom");
    });
  });

  describe("no issue", () => {
    it("returns early when webhook has no issue", async () => {
      await handleAgentSessionEvent(
        {
          type: "AgentSessionEvent",
          action: "created",
          organizationId: "org-1",
          agentSession: { id: "session-1" },
        } as any,
        makeEnv(),
        "trace-1"
      );

      // Should not call any control plane endpoints
      expect(mockControlPlaneFetch).not.toHaveBeenCalled();
    });
  });
});
