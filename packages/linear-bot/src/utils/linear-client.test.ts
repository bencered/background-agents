import { describe, expect, it, vi, beforeEach } from "vitest";
import { LinearClient } from "@linear/sdk";

// Mock the SDK
vi.mock("@linear/sdk", () => {
  const mockClient = {
    createAgentActivity: vi.fn().mockResolvedValue({ success: true }),
    updateAgentSession: vi.fn().mockResolvedValue({ success: true }),
    updateIssue: vi.fn().mockResolvedValue({ success: true }),
    issueRepositorySuggestions: vi.fn().mockResolvedValue({ suggestions: [] }),
    viewer: Promise.resolve({
      id: "bot-user-123",
      organization: Promise.resolve({ id: "org-1", name: "Org" }),
    }),
    team: vi.fn(),
    issue: vi.fn(),
  };
  return {
    LinearClient: vi.fn().mockImplementation(() => mockClient),
    __mockClient: mockClient,
  };
});

// Import after mocking
const { emitAgentActivity, getTeamStartedState, updateIssue, getAppUserId, getRepoSuggestions } =
  await import("./linear-client");

// Get the mock client instance
const { __mockClient: mockClient } = (await import("@linear/sdk")) as unknown as {
  __mockClient: ReturnType<typeof vi.fn> & Record<string, ReturnType<typeof vi.fn>>;
};

function makeClient(): LinearClient {
  return new LinearClient({ accessToken: "test" });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── emitAgentActivity ─────────────────────────────────────────────────────

describe("emitAgentActivity", () => {
  it("sends basic activity without signal", async () => {
    await emitAgentActivity(makeClient(), "session-1", { type: "thought", body: "Thinking..." });

    expect(mockClient.createAgentActivity).toHaveBeenCalledWith({
      agentSessionId: "session-1",
      content: { type: "thought", body: "Thinking..." },
      ephemeral: undefined,
    });
  });

  it("includes ephemeral flag when set", async () => {
    await emitAgentActivity(makeClient(), "session-1", { type: "thought", body: "..." }, true);

    expect(mockClient.createAgentActivity).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true })
    );
  });

  it("includes signal and signalMetadata when provided", async () => {
    await emitAgentActivity(
      makeClient(),
      "session-1",
      { type: "elicitation", body: "Pick a repo" },
      false,
      "select",
      { options: ["org/repo-a", "org/repo-b"] }
    );

    expect(mockClient.createAgentActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: "select",
        signalMetadata: { options: ["org/repo-a", "org/repo-b"] },
      })
    );
  });

  it("omits signal fields when not provided", async () => {
    await emitAgentActivity(makeClient(), "session-1", { type: "response", body: "Done" });

    const call = mockClient.createAgentActivity.mock.calls[0][0];
    expect(call).not.toHaveProperty("signal");
    expect(call).not.toHaveProperty("signalMetadata");
  });

  it("does not throw on SDK error", async () => {
    mockClient.createAgentActivity.mockRejectedValueOnce(new Error("API error"));
    await emitAgentActivity(makeClient(), "session-1", { type: "error", body: "fail" });
    // Should not throw
  });
});

// ─── getTeamStartedState ────────────────────────────────────────────────────

describe("getTeamStartedState", () => {
  it("returns the state with lowest position", async () => {
    mockClient.team.mockResolvedValueOnce({
      states: vi.fn().mockResolvedValueOnce({
        nodes: [
          { id: "state-2", name: "In Review", position: 2 },
          { id: "state-1", name: "In Progress", position: 1 },
          { id: "state-3", name: "Building", position: 3 },
        ],
      }),
    });

    const result = await getTeamStartedState(makeClient(), "team-1");
    expect(result).toEqual({ id: "state-1", name: "In Progress" });
  });

  it("returns null when no started states exist", async () => {
    mockClient.team.mockResolvedValueOnce({
      states: vi.fn().mockResolvedValueOnce({ nodes: [] }),
    });

    const result = await getTeamStartedState(makeClient(), "team-1");
    expect(result).toBeNull();
  });

  it("returns null on SDK error", async () => {
    mockClient.team.mockRejectedValueOnce(new Error("API error"));
    const result = await getTeamStartedState(makeClient(), "team-1");
    expect(result).toBeNull();
  });
});

// ─── updateIssue ────────────────────────────────────────────────────────────

describe("updateIssue", () => {
  it("returns true on successful update", async () => {
    mockClient.updateIssue.mockResolvedValueOnce({ success: true });

    const result = await updateIssue(makeClient(), "issue-1", { stateId: "state-1" });
    expect(result).toBe(true);
    expect(mockClient.updateIssue).toHaveBeenCalledWith("issue-1", { stateId: "state-1" });
  });

  it("returns false on SDK error", async () => {
    mockClient.updateIssue.mockRejectedValueOnce(new Error("API error"));
    const result = await updateIssue(makeClient(), "issue-1", { stateId: "state-1" });
    expect(result).toBe(false);
  });

  it("returns false when mutation returns success=false", async () => {
    mockClient.updateIssue.mockResolvedValueOnce({ success: false });
    const result = await updateIssue(makeClient(), "issue-1", { stateId: "state-1" });
    expect(result).toBe(false);
  });
});

// ─── getAppUserId ───────────────────────────────────────────────────────────

describe("getAppUserId", () => {
  it("returns the viewer id", async () => {
    const result = await getAppUserId(makeClient());
    expect(result).toBe("bot-user-123");
  });
});

// ─── getRepoSuggestions ─────────────────────────────────────────────────────

describe("getRepoSuggestions", () => {
  it("returns suggestions", async () => {
    mockClient.issueRepositorySuggestions.mockResolvedValueOnce({
      suggestions: [
        { repositoryFullName: "org/repo-a", confidence: 0.9 },
        { repositoryFullName: "org/repo-b", confidence: 0.3 },
      ],
    });

    const result = await getRepoSuggestions(makeClient(), "issue-1", "session-1", [
      { hostname: "github.com", repositoryFullName: "org/repo-a" },
    ]);

    expect(result).toHaveLength(2);
    expect(result[0].repositoryFullName).toBe("org/repo-a");
  });

  it("returns empty array on SDK error", async () => {
    mockClient.issueRepositorySuggestions.mockRejectedValueOnce(new Error("API error"));
    const result = await getRepoSuggestions(makeClient(), "issue-1", "session-1", []);
    expect(result).toEqual([]);
  });
});
