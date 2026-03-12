"use client";

import { useState } from "react";
import type { McpServerConfig } from "@open-inspect/shared";
import {
  useMcpServers,
  createMcpServer,
  updateMcpServer,
  deleteMcpServer,
} from "@/hooks/use-mcp-servers";
import { PlusIcon, TerminalIcon, GlobeIcon, ErrorIcon } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";

type FormState = {
  name: string;
  type: "stdio" | "remote";
  command: string;
  url: string;
  env: string;
  repoScope: string;
  enabled: boolean;
};

const emptyForm: FormState = {
  name: "",
  type: "remote",
  command: "",
  url: "",
  env: "",
  repoScope: "",
  enabled: true,
};

function configToForm(config: McpServerConfig): FormState {
  return {
    name: config.name,
    type: config.type,
    command: config.command?.join(" ") ?? "",
    url: config.url ?? "",
    env: config.env && Object.keys(config.env).length > 0
      ? Object.entries(config.env).map(([k, v]) => `${k}=${v}`).join("\n")
      : "",
    repoScope: config.repoScope ?? "",
    enabled: config.enabled,
  };
}

function parseEnv(envStr: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of envStr.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      result[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
    }
  }
  return result;
}

function parseCommand(cmd: string): string[] {
  return cmd.trim().split(/\s+/).filter(Boolean);
}

export function McpServersSettings() {
  const { servers, loading, mutate } = useMcpServers();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function startNew() {
    setForm(emptyForm);
    setEditing("new");
    setError(null);
  }

  function startEdit(server: McpServerConfig) {
    setForm(configToForm(server));
    setEditing(server.id);
    setError(null);
  }

  function cancel() {
    setEditing(null);
    setError(null);
  }

  async function save() {
    if (!form.name.trim()) {
      setError("Name is required");
      return;
    }
    if (form.type === "remote" && !form.url.trim()) {
      setError("URL is required for remote servers");
      return;
    }
    if (form.type === "stdio" && !form.command.trim()) {
      setError("Command is required for stdio servers");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const payload: Partial<McpServerConfig> = {
        name: form.name.trim(),
        type: form.type,
        enabled: form.enabled,
        repoScope: form.repoScope.trim() || null,
        env: parseEnv(form.env),
      };

      if (form.type === "remote") {
        payload.url = form.url.trim();
      } else {
        payload.command = parseCommand(form.command);
      }

      if (editing === "new") {
        await createMcpServer(payload as Omit<McpServerConfig, "id">);
      } else if (editing) {
        await updateMcpServer(editing, payload);
      }

      setEditing(null);
      mutate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteMcpServer(id);
      mutate();
      if (editing === id) setEditing(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
    }
  }

  async function handleToggle(server: McpServerConfig) {
    try {
      await updateMcpServer(server.id, { enabled: !server.enabled });
      mutate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to toggle");
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-xl font-semibold text-foreground">MCP Servers</h2>
        {!editing && (
          <Button onClick={startNew} variant="outline" size="sm">
            <PlusIcon className="w-3.5 h-3.5 mr-1" />
            Add Server
          </Button>
        )}
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        Configure Model Context Protocol servers that are available to agent sessions.
      </p>

      {error && (
        <div className="flex items-center gap-2 text-sm text-red-400 mb-4 px-3 py-2 bg-red-400/10 rounded">
          <ErrorIcon className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* Add/Edit form */}
      {editing && (
        <div className="border border-border rounded-md p-4 mb-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">Name</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. playwright, context7"
              className="w-full px-3 py-2 text-sm border border-border bg-input text-foreground rounded-sm focus:outline-none focus:border-foreground/30"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-1">Type</label>
            <div className="flex gap-2">
              <button
                onClick={() => setForm({ ...form, type: "remote" })}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-sm border transition ${
                  form.type === "remote"
                    ? "border-foreground/30 text-foreground bg-muted"
                    : "border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                <GlobeIcon className="w-3.5 h-3.5" />
                Remote
              </button>
              <button
                onClick={() => setForm({ ...form, type: "stdio" })}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-sm border transition ${
                  form.type === "stdio"
                    ? "border-foreground/30 text-foreground bg-muted"
                    : "border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                <TerminalIcon className="w-3.5 h-3.5" />
                Stdio
              </button>
            </div>
          </div>

          {form.type === "remote" ? (
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">URL</label>
              <input
                type="url"
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
                placeholder="https://mcp.example.com/sse"
                className="w-full px-3 py-2 text-sm border border-border bg-input text-foreground rounded-sm focus:outline-none focus:border-foreground/30"
              />
            </div>
          ) : (
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">Command</label>
              <input
                type="text"
                value={form.command}
                onChange={(e) => setForm({ ...form, command: e.target.value })}
                placeholder="npx -y @playwright/mcp"
                className="w-full px-3 py-2 text-sm border border-border bg-input text-foreground rounded-sm focus:outline-none focus:border-foreground/30"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Space-separated command and arguments
              </p>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Environment Variables <span className="text-muted-foreground font-normal">(optional)</span>
            </label>
            <textarea
              value={form.env}
              onChange={(e) => setForm({ ...form, env: e.target.value })}
              placeholder={"KEY=value\nANOTHER_KEY=value"}
              rows={3}
              className="w-full px-3 py-2 text-sm border border-border bg-input text-foreground rounded-sm focus:outline-none focus:border-foreground/30 font-mono"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Repository Scope <span className="text-muted-foreground font-normal">(optional)</span>
            </label>
            <input
              type="text"
              value={form.repoScope}
              onChange={(e) => setForm({ ...form, repoScope: e.target.value })}
              placeholder="owner/repo (leave empty for global)"
              className="w-full px-3 py-2 text-sm border border-border bg-input text-foreground rounded-sm focus:outline-none focus:border-foreground/30"
            />
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="mcp-enabled"
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
              className="rounded border-border"
            />
            <label htmlFor="mcp-enabled" className="text-sm text-foreground">
              Enabled
            </label>
          </div>

          <div className="flex gap-2 pt-2">
            <Button onClick={save} disabled={saving} size="sm">
              {saving ? "Saving..." : editing === "new" ? "Add Server" : "Save Changes"}
            </Button>
            <Button onClick={cancel} variant="outline" size="sm">
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Server list */}
      {loading ? (
        <div className="text-sm text-muted-foreground">Loading...</div>
      ) : servers.length === 0 && !editing ? (
        <div className="text-sm text-muted-foreground py-8 text-center">
          No MCP servers configured. Add one to extend agent capabilities.
        </div>
      ) : (
        <div className="space-y-2">
          {servers.map((server) => (
            <div
              key={server.id}
              className={`flex items-center justify-between px-4 py-3 border rounded-md transition ${
                server.enabled
                  ? "border-border bg-card"
                  : "border-border/50 bg-card/50 opacity-60"
              }`}
            >
              <div className="flex items-center gap-3 min-w-0">
                {server.type === "remote" ? (
                  <GlobeIcon className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                ) : (
                  <TerminalIcon className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                )}
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground truncate">
                    {server.name}
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    {server.type === "remote"
                      ? server.url
                      : server.command?.join(" ")}
                    {server.repoScope && (
                      <span className="ml-2 text-accent">• {server.repoScope}</span>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  onClick={() => handleToggle(server)}
                  className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground transition"
                >
                  {server.enabled ? "Disable" : "Enable"}
                </button>
                <button
                  onClick={() => startEdit(server)}
                  className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground transition"
                >
                  Edit
                </button>
                <button
                  onClick={() => handleDelete(server.id)}
                  className="px-2 py-1 text-xs text-red-400 hover:text-red-300 transition"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
