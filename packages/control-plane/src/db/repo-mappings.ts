/**
 * D1 repository for repo_mappings table.
 * Supports Linear project/team → GitHub repo mapping.
 */

export interface RepoMapping {
  id: number;
  integration_id: string;
  source_type: "team" | "project";
  source_id: string;
  source_name: string;
  repo_owner: string;
  repo_name: string;
  label_filter: string | null;
  is_default: boolean;
  created_at: number;
  updated_at: number;
}

export interface CreateRepoMappingInput {
  integration_id: string;
  source_type: "team" | "project";
  source_id: string;
  source_name: string;
  repo_owner: string;
  repo_name: string;
  label_filter?: string | null;
  is_default?: boolean;
}

export interface UpdateRepoMappingInput {
  source_name?: string;
  repo_owner?: string;
  repo_name?: string;
  label_filter?: string | null;
  is_default?: boolean;
}

export interface ResolveRepoMappingInput {
  teamId?: string | null;
  projectId?: string | null;
  labels?: string[];
}

export interface ResolvedRepo {
  owner: string;
  name: string;
  reasoning: string;
}

function rowToMapping(row: Record<string, unknown>): RepoMapping {
  return {
    id: row.id as number,
    integration_id: row.integration_id as string,
    source_type: row.source_type as "team" | "project",
    source_id: row.source_id as string,
    source_name: row.source_name as string,
    repo_owner: row.repo_owner as string,
    repo_name: row.repo_name as string,
    label_filter: (row.label_filter as string | null) ?? null,
    is_default: Boolean(row.is_default),
    created_at: row.created_at as number,
    updated_at: row.updated_at as number,
  };
}

export class RepoMappingStore {
  constructor(private readonly db: D1Database) {}

  async list(integrationId: string): Promise<RepoMapping[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, integration_id, source_type, source_id, source_name,
                repo_owner, repo_name, label_filter, is_default, created_at, updated_at
         FROM repo_mappings
         WHERE integration_id = ?
         ORDER BY source_type, source_id, is_default DESC, id ASC`
      )
      .bind(integrationId)
      .all<Record<string, unknown>>();

    return results.map(rowToMapping);
  }

  async getById(integrationId: string, id: number): Promise<RepoMapping | null> {
    const row = await this.db
      .prepare(
        `SELECT id, integration_id, source_type, source_id, source_name,
                repo_owner, repo_name, label_filter, is_default, created_at, updated_at
         FROM repo_mappings
         WHERE integration_id = ? AND id = ?`
      )
      .bind(integrationId, id)
      .first<Record<string, unknown>>();

    return row ? rowToMapping(row) : null;
  }

  async create(input: CreateRepoMappingInput): Promise<RepoMapping> {
    const now = Date.now();
    const result = await this.db
      .prepare(
        `INSERT INTO repo_mappings
           (integration_id, source_type, source_id, source_name, repo_owner, repo_name,
            label_filter, is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id, integration_id, source_type, source_id, source_name,
                   repo_owner, repo_name, label_filter, is_default, created_at, updated_at`
      )
      .bind(
        input.integration_id,
        input.source_type,
        input.source_id,
        input.source_name,
        input.repo_owner,
        input.repo_name,
        input.label_filter ?? null,
        input.is_default ? 1 : 0,
        now,
        now
      )
      .first<Record<string, unknown>>();

    if (!result) {
      throw new Error("Failed to create repo mapping");
    }

    return rowToMapping(result);
  }

  async update(integrationId: string, id: number, input: UpdateRepoMappingInput): Promise<RepoMapping | null> {
    const existing = await this.getById(integrationId, id);
    if (!existing) return null;

    const now = Date.now();
    const result = await this.db
      .prepare(
        `UPDATE repo_mappings
         SET source_name = ?,
             repo_owner = ?,
             repo_name = ?,
             label_filter = ?,
             is_default = ?,
             updated_at = ?
         WHERE integration_id = ? AND id = ?
         RETURNING id, integration_id, source_type, source_id, source_name,
                   repo_owner, repo_name, label_filter, is_default, created_at, updated_at`
      )
      .bind(
        input.source_name ?? existing.source_name,
        input.repo_owner ?? existing.repo_owner,
        input.repo_name ?? existing.repo_name,
        input.label_filter !== undefined ? (input.label_filter ?? null) : existing.label_filter,
        input.is_default !== undefined ? (input.is_default ? 1 : 0) : (existing.is_default ? 1 : 0),
        now,
        integrationId,
        id
      )
      .first<Record<string, unknown>>();

    return result ? rowToMapping(result) : null;
  }

  async delete(integrationId: string, id: number): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM repo_mappings WHERE integration_id = ? AND id = ?")
      .bind(integrationId, id)
      .run();

    return (result.meta?.changes ?? 0) > 0;
  }

  /**
   * Resolve the best repo for a given issue context.
   * Priority: project mapping (with label match) → project mapping (no filter) →
   *           team mapping (with label match) → team mapping (no filter, default) →
   *           team mapping (no filter, any)
   */
  async resolve(
    integrationId: string,
    input: ResolveRepoMappingInput
  ): Promise<ResolvedRepo | null> {
    const { teamId, projectId, labels = [] } = input;

    // Fetch all candidate rows for this integration
    const candidateIds: string[] = [];
    if (projectId) candidateIds.push(projectId);
    if (teamId) candidateIds.push(teamId);

    if (candidateIds.length === 0) return null;

    const { results } = await this.db
      .prepare(
        `SELECT id, integration_id, source_type, source_id, source_name,
                repo_owner, repo_name, label_filter, is_default, created_at, updated_at
         FROM repo_mappings
         WHERE integration_id = ? AND source_id IN (${candidateIds.map(() => "?").join(",")})
         ORDER BY
           CASE source_type WHEN 'project' THEN 0 ELSE 1 END ASC,
           is_default DESC,
           id ASC`
      )
      .bind(integrationId, ...candidateIds)
      .all<Record<string, unknown>>();

    const mappings = results.map(rowToMapping);

    // 1. Project mapping with matching label
    if (projectId && labels.length > 0) {
      const match = mappings.find(
        (m) =>
          m.source_type === "project" &&
          m.source_id === projectId &&
          m.label_filter !== null &&
          labels.some((l) => l.toLowerCase() === m.label_filter!.toLowerCase())
      );
      if (match) {
        return {
          owner: match.repo_owner,
          name: match.repo_name,
          reasoning: `Project "${match.source_name}" mapped to ${match.repo_owner}/${match.repo_name} (label: ${match.label_filter})`,
        };
      }
    }

    // 2. Project mapping with no label filter
    if (projectId) {
      const match = mappings.find(
        (m) =>
          m.source_type === "project" &&
          m.source_id === projectId &&
          m.label_filter === null
      );
      if (match) {
        return {
          owner: match.repo_owner,
          name: match.repo_name,
          reasoning: `Project "${match.source_name}" mapped to ${match.repo_owner}/${match.repo_name}`,
        };
      }
    }

    // 3. Team mapping with matching label
    if (teamId && labels.length > 0) {
      const match = mappings.find(
        (m) =>
          m.source_type === "team" &&
          m.source_id === teamId &&
          m.label_filter !== null &&
          labels.some((l) => l.toLowerCase() === m.label_filter!.toLowerCase())
      );
      if (match) {
        return {
          owner: match.repo_owner,
          name: match.repo_name,
          reasoning: `Team "${match.source_name}" mapped to ${match.repo_owner}/${match.repo_name} (label: ${match.label_filter})`,
        };
      }
    }

    // 4. Team mapping with no label filter (prefer default)
    if (teamId) {
      const teamMappings = mappings.filter(
        (m) => m.source_type === "team" && m.source_id === teamId && m.label_filter === null
      );
      const match = teamMappings.find((m) => m.is_default) ?? teamMappings[0];
      if (match) {
        return {
          owner: match.repo_owner,
          name: match.repo_name,
          reasoning: `Team "${match.source_name}" mapped to ${match.repo_owner}/${match.repo_name}`,
        };
      }
    }

    return null;
  }
}
