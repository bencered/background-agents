import type { McpServerConfig } from "@open-inspect/shared";

function generateId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

interface McpServerRow {
  id: string;
  name: string;
  type: string;
  command: string | null;
  url: string | null;
  env: string;
  repo_scope: string | null;
  enabled: number;
  created_at: number;
  updated_at: number;
}

function rowToConfig(row: McpServerRow): McpServerConfig {
  return {
    id: row.id,
    name: row.name,
    type: row.type as "stdio" | "remote",
    command: row.command ? JSON.parse(row.command) : undefined,
    url: row.url ?? undefined,
    env: JSON.parse(row.env),
    repoScope: row.repo_scope,
    enabled: row.enabled === 1,
  };
}

export class McpServerStore {
  constructor(private readonly db: D1Database) {}

  async list(repoScope?: string): Promise<McpServerConfig[]> {
    let stmt;
    if (repoScope !== undefined) {
      stmt = this.db
        .prepare("SELECT * FROM mcp_servers WHERE repo_scope = ? ORDER BY name")
        .bind(repoScope);
    } else {
      stmt = this.db.prepare("SELECT * FROM mcp_servers ORDER BY name");
    }
    const { results } = await stmt.all<McpServerRow>();
    return results.map(rowToConfig);
  }

  async get(id: string): Promise<McpServerConfig | null> {
    const row = await this.db
      .prepare("SELECT * FROM mcp_servers WHERE id = ?")
      .bind(id)
      .first<McpServerRow>();
    return row ? rowToConfig(row) : null;
  }

  async create(config: Omit<McpServerConfig, "id">): Promise<McpServerConfig> {
    const id = generateId();
    const now = Date.now();

    if (config.type === "stdio" && (!config.command || config.command.length === 0)) {
      throw new Error("stdio MCP servers require a command");
    }
    if (config.type === "remote" && !config.url) {
      throw new Error("remote MCP servers require a URL");
    }

    await this.db
      .prepare(
        `INSERT INTO mcp_servers (id, name, type, command, url, env, repo_scope, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        config.name,
        config.type,
        config.command ? JSON.stringify(config.command) : null,
        config.url ?? null,
        JSON.stringify(config.env ?? {}),
        config.repoScope ?? null,
        config.enabled ? 1 : 0,
        now,
        now
      )
      .run();

    return { ...config, id };
  }

  async update(id: string, patch: Partial<Omit<McpServerConfig, "id">>): Promise<McpServerConfig | null> {
    const existing = await this.get(id);
    if (!existing) return null;

    const merged = { ...existing, ...patch };
    const now = Date.now();

    await this.db
      .prepare(
        `UPDATE mcp_servers SET name = ?, type = ?, command = ?, url = ?, env = ?, repo_scope = ?, enabled = ?, updated_at = ?
         WHERE id = ?`
      )
      .bind(
        merged.name,
        merged.type,
        merged.command ? JSON.stringify(merged.command) : null,
        merged.url ?? null,
        JSON.stringify(merged.env ?? {}),
        merged.repoScope ?? null,
        merged.enabled ? 1 : 0,
        now,
        id
      )
      .run();

    return merged;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM mcp_servers WHERE id = ?")
      .bind(id)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  /** Get all enabled MCP servers applicable to a session (global + repo-specific). */
  async getForSession(repoOwner: string, repoName: string): Promise<McpServerConfig[]> {
    const repoFullName = `${repoOwner}/${repoName}`.toLowerCase();
    const { results } = await this.db
      .prepare(
        "SELECT * FROM mcp_servers WHERE enabled = 1 AND (repo_scope IS NULL OR LOWER(repo_scope) = ?) ORDER BY name"
      )
      .bind(repoFullName)
      .all<McpServerRow>();
    return results.map(rowToConfig);
  }
}
