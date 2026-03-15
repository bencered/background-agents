"use client";

import { useEffect, useState, type ReactNode } from "react";
import useSWR, { mutate } from "swr";
import { toast } from "sonner";
import {
  MODEL_REASONING_CONFIG,
  isValidReasoningEffort,
  type EnrichedRepository,
  type LinearBotSettings,
  type LinearGlobalConfig,
  type ValidModel,
} from "@open-inspect/shared";
import { useEnabledModels } from "@/hooks/use-enabled-models";
import { IntegrationSettingsSkeleton } from "./integration-settings-skeleton";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { RadioCard } from "@/components/ui/form-controls";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

// ─── Repo Mapping Types ───────────────────────────────────────────────────────

interface RepoMapping {
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

interface LinearTeam {
  id: string;
  name: string;
  key: string;
}

interface LinearProject {
  id: string;
  name: string;
}

const GLOBAL_SETTINGS_KEY = "/api/integration-settings/linear";
const REPO_SETTINGS_KEY = "/api/integration-settings/linear/repos";
const REPO_MAPPINGS_KEY = "/api/integration-settings/linear/repo-mappings";
const LINEAR_TEAMS_KEY = "/api/linear/teams";
const LINEAR_PROJECTS_KEY = "/api/linear/projects";

interface GlobalResponse {
  settings: LinearGlobalConfig | null;
}

interface RepoSettingsEntry {
  repo: string;
  settings: LinearBotSettings;
}

interface RepoListResponse {
  repos: RepoSettingsEntry[];
}

interface ReposResponse {
  repos: EnrichedRepository[];
}

interface RepoMappingsResponse {
  mappings: RepoMapping[];
}

interface LinearTeamsResponse {
  teams: LinearTeam[];
}

interface LinearProjectsResponse {
  projects: LinearProject[];
}

export function LinearIntegrationSettings() {
  const { data: globalData, isLoading: globalLoading } =
    useSWR<GlobalResponse>(GLOBAL_SETTINGS_KEY);
  const { data: repoSettingsData, isLoading: repoSettingsLoading } =
    useSWR<RepoListResponse>(REPO_SETTINGS_KEY);
  const { data: reposData } = useSWR<ReposResponse>("/api/repos");
  const { data: repoMappingsData } = useSWR<RepoMappingsResponse>(REPO_MAPPINGS_KEY);
  const { data: teamsData } = useSWR<LinearTeamsResponse>(LINEAR_TEAMS_KEY);
  const { data: projectsData } = useSWR<LinearProjectsResponse>(LINEAR_PROJECTS_KEY);
  const { enabledModelOptions } = useEnabledModels();

  if (globalLoading || repoSettingsLoading) {
    return <IntegrationSettingsSkeleton />;
  }

  const settings = globalData?.settings;
  const repoOverrides = repoSettingsData?.repos ?? [];
  const availableRepos = reposData?.repos ?? [];
  const repoMappings = repoMappingsData?.mappings ?? [];
  const linearTeams = teamsData?.teams ?? [];
  const linearProjects = projectsData?.projects ?? [];

  return (
    <div>
      <h3 className="text-lg font-semibold text-foreground mb-1">Linear Agent</h3>
      <p className="text-sm text-muted-foreground mb-6">
        Configure model defaults, repository targeting, and runtime behavior for Linear-triggered
        sessions.
      </p>

      <Section title="Connection" description="Linear uses control-plane repository access.">
        {availableRepos.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            Repository access is available. You can target all repos or limit the integration to a
            selected allowlist.
          </p>
        ) : (
          <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 px-4 py-3 rounded-sm">
            No repositories are currently accessible from the control plane. Repository filtering is
            unavailable until repository access is configured.
          </p>
        )}
      </Section>

      <Section
        title="Repository Mapping"
        description="Map Linear teams or projects to specific GitHub repositories. Project mappings take priority over team mappings."
      >
        <RepoMappingSection
          mappings={repoMappings}
          availableRepos={availableRepos}
          linearTeams={linearTeams}
          linearProjects={linearProjects}
        />
      </Section>

      <GlobalSettingsSection
        settings={settings}
        availableRepos={availableRepos}
        enabledModelOptions={enabledModelOptions}
      />

      <Section
        title="Repository Overrides"
        description="Override model selection and behavior for specific repositories."
      >
        <RepoOverridesSection
          overrides={repoOverrides}
          availableRepos={availableRepos}
          enabledModelOptions={enabledModelOptions}
        />
      </Section>
    </div>
  );
}

function RepoMappingSection({
  mappings,
  availableRepos,
  linearTeams,
  linearProjects,
}: {
  mappings: RepoMapping[];
  availableRepos: EnrichedRepository[];
  linearTeams: LinearTeam[];
  linearProjects: LinearProject[];
}) {
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // New mapping form state
  const [newSourceType, setNewSourceType] = useState<"team" | "project">("team");
  const [newSourceId, setNewSourceId] = useState("");
  const [newRepo, setNewRepo] = useState("");
  const [newLabelFilter, setNewLabelFilter] = useState("");
  const [newIsDefault, setNewIsDefault] = useState(false);
  const [saving, setSaving] = useState(false);

  const sourceOptions = newSourceType === "team" ? linearTeams : linearProjects;
  const selectedSource = sourceOptions.find((s) => s.id === newSourceId);

  const resetForm = () => {
    setNewSourceType("team");
    setNewSourceId("");
    setNewRepo("");
    setNewLabelFilter("");
    setNewIsDefault(false);
    setAdding(false);
  };

  const handleCreate = async () => {
    if (!newSourceId || !newRepo) return;
    const [repoOwner, repoName] = newRepo.split("/");
    if (!repoOwner || !repoName) return;

    setSaving(true);
    setError("");
    setSuccess("");

    const sourceName = selectedSource?.name ?? newSourceId;

    try {
      const res = await fetch(REPO_MAPPINGS_KEY, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_type: newSourceType,
          source_id: newSourceId,
          source_name: sourceName,
          repo_owner: repoOwner,
          repo_name: repoName,
          label_filter: newLabelFilter.trim() || null,
          is_default: newIsDefault,
        }),
      });

      if (res.ok) {
        await mutate(REPO_MAPPINGS_KEY);
        resetForm();
        setSuccess("Mapping added.");
      } else {
        const data = await res.json();
        setError((data as { error?: string }).error ?? "Failed to add mapping");
      }
    } catch {
      setError("Failed to add mapping");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      {error && <Message tone="error" text={error} />}
      {success && <Message tone="success" text={success} />}

      {mappings.length > 0 ? (
        <div className="space-y-2 mb-4">
          {mappings.map((m) => (
            <RepoMappingRow
              key={m.id}
              mapping={m}
              availableRepos={availableRepos}
              linearTeams={linearTeams}
              linearProjects={linearProjects}
              onError={setError}
              onSuccess={setSuccess}
            />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground mb-4">
          No repository mappings yet. Add one to automatically route Linear issues to specific repos.
        </p>
      )}

      {adding ? (
        <div className="border border-border rounded-sm p-4 space-y-3">
          <p className="text-sm font-medium text-foreground">Add Repository Mapping</p>

          <div className="grid sm:grid-cols-2 gap-3">
            <label className="text-sm">
              <span className="block text-foreground font-medium mb-1">Source type</span>
              <Select
                value={newSourceType}
                onValueChange={(v) => {
                  setNewSourceType(v as "team" | "project");
                  setNewSourceId("");
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="team">Team</SelectItem>
                  <SelectItem value="project">Project</SelectItem>
                </SelectContent>
              </Select>
            </label>

            <label className="text-sm">
              <span className="block text-foreground font-medium mb-1">
                {newSourceType === "team" ? "Team" : "Project"}
              </span>
              <Select value={newSourceId} onValueChange={setNewSourceId}>
                <SelectTrigger className="w-full">
                  <SelectValue
                    placeholder={
                      sourceOptions.length === 0
                        ? newSourceType === "team"
                          ? "No teams found (OAuth required)"
                          : "No projects found (OAuth required)"
                        : `Select a ${newSourceType}...`
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {sourceOptions.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          </div>

          <div className="grid sm:grid-cols-2 gap-3">
            <label className="text-sm">
              <span className="block text-foreground font-medium mb-1">Repository</span>
              <Select value={newRepo} onValueChange={setNewRepo}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select a repository..." />
                </SelectTrigger>
                <SelectContent>
                  {availableRepos.map((r) => (
                    <SelectItem key={r.fullName} value={r.fullName.toLowerCase()}>
                      {r.fullName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>

            <label className="text-sm">
              <span className="block text-foreground font-medium mb-1">
                Label filter <span className="text-muted-foreground font-normal">(optional)</span>
              </span>
              <Input
                value={newLabelFilter}
                onChange={(e) => setNewLabelFilter(e.target.value)}
                placeholder="e.g. backend"
              />
            </label>
          </div>

          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <Checkbox
              checked={newIsDefault}
              onCheckedChange={(checked) => setNewIsDefault(!!checked)}
            />
            <span>Mark as default mapping for this source</span>
          </label>

          <div className="flex items-center gap-2 pt-1">
            <Button
              onClick={handleCreate}
              disabled={saving || !newSourceId || !newRepo}
            >
              {saving ? "Adding..." : "Add Mapping"}
            </Button>
            <Button variant="outline" onClick={resetForm} disabled={saving}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button onClick={() => setAdding(true)}>Add Mapping</Button>
      )}
    </div>
  );
}

function RepoMappingRow({
  mapping,
  availableRepos,
  linearTeams,
  linearProjects,
  onError,
  onSuccess,
}: {
  mapping: RepoMapping;
  availableRepos: EnrichedRepository[];
  linearTeams: LinearTeam[];
  linearProjects: LinearProject[];
  onError: (msg: string) => void;
  onSuccess: (msg: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editRepo, setEditRepo] = useState(
    `${mapping.repo_owner}/${mapping.repo_name}`
  );
  const [editLabelFilter, setEditLabelFilter] = useState(mapping.label_filter ?? "");
  const [editIsDefault, setEditIsDefault] = useState(mapping.is_default);
  const [saving, setSaving] = useState(false);

  // Find source name from teams/projects list (fallback to stored name)
  const sourceOptions = mapping.source_type === "team" ? linearTeams : linearProjects;
  const liveSource = sourceOptions.find((s) => s.id === mapping.source_id);
  const sourceName = liveSource?.name ?? mapping.source_name;

  const handleSave = async () => {
    const [repoOwner, repoName] = editRepo.split("/");
    if (!repoOwner || !repoName) return;

    setSaving(true);
    onError("");
    onSuccess("");

    try {
      const res = await fetch(`${REPO_MAPPINGS_KEY}/${mapping.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo_owner: repoOwner,
          repo_name: repoName,
          label_filter: editLabelFilter.trim() || null,
          is_default: editIsDefault,
        }),
      });

      if (res.ok) {
        await mutate(REPO_MAPPINGS_KEY);
        setEditing(false);
        onSuccess("Mapping updated.");
      } else {
        const data = await res.json();
        onError((data as { error?: string }).error ?? "Failed to update mapping");
      }
    } catch {
      onError("Failed to update mapping");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    onError("");
    onSuccess("");

    try {
      const res = await fetch(`${REPO_MAPPINGS_KEY}/${mapping.id}`, {
        method: "DELETE",
      });

      if (res.ok) {
        await mutate(REPO_MAPPINGS_KEY);
        onSuccess("Mapping removed.");
      } else {
        const data = await res.json();
        onError((data as { error?: string }).error ?? "Failed to remove mapping");
      }
    } catch {
      onError("Failed to remove mapping");
    }
  };

  const sourceTypeLabel = mapping.source_type === "team" ? "Team" : "Project";

  if (editing) {
    return (
      <div className="border border-border rounded-sm p-3 space-y-3">
        <div className="flex items-center gap-2 text-sm">
          <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-muted text-muted-foreground">
            {sourceTypeLabel}
          </span>
          <span className="font-medium text-foreground">{sourceName}</span>
        </div>

        <div className="grid sm:grid-cols-2 gap-3">
          <label className="text-sm">
            <span className="block text-foreground font-medium mb-1">Repository</span>
            <Select value={editRepo} onValueChange={setEditRepo}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {availableRepos.map((r) => (
                  <SelectItem key={r.fullName} value={r.fullName.toLowerCase()}>
                    {r.fullName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          <label className="text-sm">
            <span className="block text-foreground font-medium mb-1">
              Label filter <span className="text-muted-foreground font-normal">(optional)</span>
            </span>
            <Input
              value={editLabelFilter}
              onChange={(e) => setEditLabelFilter(e.target.value)}
              placeholder="e.g. backend"
              className="h-8"
            />
          </label>
        </div>

        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <Checkbox
            checked={editIsDefault}
            onCheckedChange={(checked) => setEditIsDefault(!!checked)}
          />
          <span>Default mapping for this source</span>
        </label>

        <div className="flex items-center gap-2">
          <Button size="sm" onClick={handleSave} disabled={saving || !editRepo}>
            {saving ? "..." : "Save"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setEditing(false)} disabled={saving}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 px-3 py-2 border border-border rounded-sm text-sm">
      <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-muted text-muted-foreground shrink-0">
        {sourceTypeLabel}
      </span>
      <span className="font-medium text-foreground shrink-0">{sourceName}</span>
      <span className="text-muted-foreground shrink-0">→</span>
      <span className="text-foreground font-mono text-xs shrink-0">
        {mapping.repo_owner}/{mapping.repo_name}
      </span>
      {mapping.label_filter && (
        <span className="px-1.5 py-0.5 rounded text-xs bg-blue-50 text-blue-700 border border-blue-200 shrink-0">
          {mapping.label_filter}
        </span>
      )}
      {mapping.is_default && (
        <span className="text-amber-500 shrink-0" title="Default mapping">
          ★
        </span>
      )}
      <div className="flex items-center gap-1 ml-auto shrink-0">
        <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
          Edit
        </Button>
        <Button size="sm" variant="destructive" onClick={handleDelete}>
          Remove
        </Button>
      </div>
    </div>
  );
}

function GlobalSettingsSection({
  settings,
  availableRepos,
  enabledModelOptions,
}: {
  settings: LinearGlobalConfig | null | undefined;
  availableRepos: EnrichedRepository[];
  enabledModelOptions: { category: string; models: { id: string; name: string }[] }[];
}) {
  const [model, setModel] = useState(settings?.defaults?.model ?? "");
  const [effort, setEffort] = useState(settings?.defaults?.reasoningEffort ?? "");
  const [enabledRepos, setEnabledRepos] = useState<string[]>(settings?.enabledRepos ?? []);
  const [repoScopeMode, setRepoScopeMode] = useState<"all" | "selected">(
    settings?.enabledRepos == null ? "all" : "selected"
  );
  const [allowUserPreferenceOverride, setAllowUserPreferenceOverride] = useState(
    settings?.defaults?.allowUserPreferenceOverride ?? true
  );
  const [allowLabelModelOverride, setAllowLabelModelOverride] = useState(
    settings?.defaults?.allowLabelModelOverride ?? true
  );
  const [emitToolProgressActivities, setEmitToolProgressActivities] = useState(
    settings?.defaults?.emitToolProgressActivities ?? true
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [showResetDialog, setShowResetDialog] = useState(false);

  useEffect(() => {
    if (settings !== undefined && !initialized) {
      if (settings) {
        setModel(settings.defaults?.model ?? "");
        setEffort(settings.defaults?.reasoningEffort ?? "");
        setEnabledRepos(settings.enabledRepos ?? []);
        setRepoScopeMode(settings.enabledRepos === undefined ? "all" : "selected");
        setAllowUserPreferenceOverride(settings.defaults?.allowUserPreferenceOverride ?? true);
        setAllowLabelModelOverride(settings.defaults?.allowLabelModelOverride ?? true);
        setEmitToolProgressActivities(settings.defaults?.emitToolProgressActivities ?? true);
      }
      setInitialized(true);
    }
  }, [settings, initialized]);

  const isConfigured = settings !== null && settings !== undefined;
  const reasoningConfig = model ? MODEL_REASONING_CONFIG[model as ValidModel] : undefined;

  const resetNotice =
    "Reset all Linear settings to defaults? This enables both label/user model overrides.";

  const handleReset = () => {
    setShowResetDialog(true);
  };

  const handleConfirmReset = async () => {
    setSaving(true);
    setError("");

    try {
      const res = await fetch(GLOBAL_SETTINGS_KEY, { method: "DELETE" });

      if (res.ok) {
        mutate(GLOBAL_SETTINGS_KEY);
        setModel("");
        setEffort("");
        setEnabledRepos([]);
        setRepoScopeMode("all");
        setAllowUserPreferenceOverride(true);
        setAllowLabelModelOverride(true);
        setEmitToolProgressActivities(true);
        setDirty(false);
        toast.success("Settings reset to defaults.");
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to reset settings");
      }
    } catch {
      toast.error("Failed to reset settings");
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError("");

    const defaults: LinearBotSettings = {
      allowUserPreferenceOverride,
      allowLabelModelOverride,
      emitToolProgressActivities,
    };

    if (model) defaults.model = model;
    if (effort) defaults.reasoningEffort = effort;

    const body: LinearGlobalConfig = { defaults };
    if (repoScopeMode === "selected") {
      body.enabledRepos = enabledRepos;
    }

    try {
      const res = await fetch(GLOBAL_SETTINGS_KEY, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: body }),
      });

      if (res.ok) {
        mutate(GLOBAL_SETTINGS_KEY);
        toast.success("Settings saved.");
        setDirty(false);
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to save settings");
      }
    } catch {
      toast.error("Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  const toggleRepo = (fullName: string) => {
    const lower = fullName.toLowerCase();
    setEnabledRepos((prev) =>
      prev.includes(lower) ? prev.filter((r) => r !== lower) : [...prev, lower]
    );
    setDirty(true);
    setError("");
  };

  return (
    <Section
      title="Defaults & Scope"
      description="Global model, fallback behavior, and repository targeting."
    >
      {error && <Message tone="error" text={error} />}

      <div className="grid sm:grid-cols-2 gap-3 mb-4">
        <label className="text-sm">
          <span className="block text-foreground font-medium mb-1">Default model</span>
          <Select
            value={model}
            onValueChange={(nextModel) => {
              setModel(nextModel);
              if (effort && nextModel && !isValidReasoningEffort(nextModel, effort)) {
                setEffort("");
              }
              setDirty(true);
              setError("");
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Use system default" />
            </SelectTrigger>
            <SelectContent>
              {enabledModelOptions.map((group) => (
                <SelectGroup key={group.category}>
                  <SelectLabel>{group.category}</SelectLabel>
                  {group.models.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </label>

        <label className="text-sm">
          <span className="block text-foreground font-medium mb-1">Default reasoning effort</span>
          <Select
            value={effort}
            onValueChange={(v) => {
              setEffort(v);
              setDirty(true);
              setError("");
            }}
            disabled={!reasoningConfig}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Use model default" />
            </SelectTrigger>
            <SelectContent>
              {(reasoningConfig?.efforts ?? []).map((value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      </div>

      <div className="grid sm:grid-cols-2 gap-2 mb-4">
        <label className="flex items-center justify-between px-3 py-2 border border-border rounded-sm cursor-pointer hover:bg-muted/50 transition text-sm">
          <span>Allow user model preferences</span>
          <Checkbox
            checked={allowUserPreferenceOverride}
            onCheckedChange={(checked) => {
              setAllowUserPreferenceOverride(!!checked);
              setDirty(true);
              setError("");
            }}
          />
        </label>
        <label className="flex items-center justify-between px-3 py-2 border border-border rounded-sm cursor-pointer hover:bg-muted/50 transition text-sm">
          <span>Allow model labels (model:*)</span>
          <Checkbox
            checked={allowLabelModelOverride}
            onCheckedChange={(checked) => {
              setAllowLabelModelOverride(!!checked);
              setDirty(true);
              setError("");
            }}
          />
        </label>
      </div>

      <div className="mb-4">
        <label className="flex items-center justify-between px-3 py-2 border border-border rounded-sm cursor-pointer hover:bg-muted/50 transition text-sm">
          <span>Emit tool progress activities</span>
          <Checkbox
            checked={emitToolProgressActivities}
            onCheckedChange={(checked) => {
              setEmitToolProgressActivities(!!checked);
              setDirty(true);
              setError("");
            }}
          />
        </label>
      </div>

      <div className="mb-4">
        <p className="text-sm font-medium text-foreground mb-2">Repository Scope</p>
        <div className="grid sm:grid-cols-2 gap-2 mb-3">
          <RadioCard
            name="linear-repo-scope"
            checked={repoScopeMode === "all"}
            onChange={() => {
              setRepoScopeMode("all");
              setDirty(true);
              setError("");
            }}
            label="All repositories"
            description="Linear events can run against every accessible repository."
          />
          <RadioCard
            name="linear-repo-scope"
            checked={repoScopeMode === "selected"}
            onChange={() => {
              setRepoScopeMode("selected");
              setDirty(true);
              setError("");
            }}
            label="Selected repositories"
            description="Linear events run only for repositories in the allowlist."
          />
        </div>

        {repoScopeMode === "selected" && (
          <>
            {availableRepos.length === 0 ? (
              <p className="text-sm text-muted-foreground px-4 py-3 border border-border rounded-sm">
                Repository filtering is unavailable because no repositories are accessible.
              </p>
            ) : (
              <div className="border border-border max-h-56 overflow-y-auto rounded-sm">
                {availableRepos.map((repo) => {
                  const fullName = repo.fullName.toLowerCase();
                  const isChecked = enabledRepos.includes(fullName);

                  return (
                    <label
                      key={repo.fullName}
                      className="flex items-center gap-2 px-4 py-2 hover:bg-muted/50 transition cursor-pointer text-sm"
                    >
                      <Checkbox
                        checked={isChecked}
                        onCheckedChange={() => toggleRepo(repo.fullName)}
                      />
                      <span className="text-foreground">{repo.fullName}</span>
                    </label>
                  );
                })}
              </div>
            )}

            {enabledRepos.length === 0 && availableRepos.length > 0 && (
              <p className="text-xs text-amber-700 mt-1">
                No repositories selected. The Linear integration will ignore all issues.
              </p>
            )}
          </>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={handleSave} disabled={saving || !dirty}>
          {saving ? "Saving..." : "Save"}
        </Button>

        {isConfigured && (
          <Button variant="destructive" onClick={handleReset} disabled={saving}>
            Reset to defaults
          </Button>
        )}
      </div>

      <AlertDialog open={showResetDialog} onOpenChange={setShowResetDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset to defaults</AlertDialogTitle>
            <AlertDialogDescription>{resetNotice}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmReset}>Reset</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Section>
  );
}

function RepoOverridesSection({
  overrides,
  availableRepos,
  enabledModelOptions,
}: {
  overrides: RepoSettingsEntry[];
  availableRepos: EnrichedRepository[];
  enabledModelOptions: { category: string; models: { id: string; name: string }[] }[];
}) {
  const [addingRepo, setAddingRepo] = useState("");

  const overriddenRepos = new Set(overrides.map((o) => o.repo));
  const availableForOverride = availableRepos.filter(
    (r) => !overriddenRepos.has(r.fullName.toLowerCase())
  );

  const handleAdd = async () => {
    if (!addingRepo) return;
    const [owner, name] = addingRepo.split("/");

    try {
      const res = await fetch(`/api/integration-settings/linear/repos/${owner}/${name}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: {} }),
      });

      if (res.ok) {
        mutate(REPO_SETTINGS_KEY);
        setAddingRepo("");
        toast.success("Override added.");
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to add override");
      }
    } catch {
      toast.error("Failed to add override");
    }
  };

  return (
    <div>
      {overrides.length > 0 ? (
        <div className="space-y-2 mb-4">
          {overrides.map((entry) => (
            <RepoOverrideRow
              key={entry.repo}
              entry={entry}
              enabledModelOptions={enabledModelOptions}
            />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground mb-4">
          No repository overrides yet. Add one to customize model behavior per repo.
        </p>
      )}

      <div className="flex items-center gap-2">
        <Select value={addingRepo} onValueChange={setAddingRepo}>
          <SelectTrigger className="flex-1">
            <SelectValue placeholder="Select a repository..." />
          </SelectTrigger>
          <SelectContent>
            {availableForOverride.map((repo) => (
              <SelectItem key={repo.fullName} value={repo.fullName.toLowerCase()}>
                {repo.fullName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button onClick={handleAdd} disabled={!addingRepo}>
          Add Override
        </Button>
      </div>
    </div>
  );
}

function RepoOverrideRow({
  entry,
  enabledModelOptions,
}: {
  entry: RepoSettingsEntry;
  enabledModelOptions: { category: string; models: { id: string; name: string }[] }[];
}) {
  const [model, setModel] = useState(entry.settings.model ?? "");
  const [effort, setEffort] = useState(entry.settings.reasoningEffort ?? "");
  const [allowUserPreferenceOverride, setAllowUserPreferenceOverride] = useState(
    entry.settings.allowUserPreferenceOverride ?? true
  );
  const [allowLabelModelOverride, setAllowLabelModelOverride] = useState(
    entry.settings.allowLabelModelOverride ?? true
  );
  const [emitToolProgressActivities, setEmitToolProgressActivities] = useState(
    entry.settings.emitToolProgressActivities ?? true
  );
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const reasoningConfig = model ? MODEL_REASONING_CONFIG[model as ValidModel] : undefined;

  const handleModelChange = (newModel: string) => {
    setModel(newModel);
    setDirty(true);

    if (effort && newModel && !isValidReasoningEffort(newModel, effort)) {
      setEffort("");
    }
  };

  const handleSave = async () => {
    setSaving(true);

    const [owner, name] = entry.repo.split("/");
    const settings: LinearBotSettings = {
      allowUserPreferenceOverride,
      allowLabelModelOverride,
      emitToolProgressActivities,
    };
    if (model) settings.model = model;
    if (effort) settings.reasoningEffort = effort;

    try {
      const res = await fetch(`/api/integration-settings/linear/repos/${owner}/${name}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings }),
      });

      if (res.ok) {
        mutate(REPO_SETTINGS_KEY);
        setDirty(false);
        toast.success(`Override for ${entry.repo} saved.`);
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to save override");
      }
    } catch {
      toast.error("Failed to save override");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    const [owner, name] = entry.repo.split("/");

    try {
      const res = await fetch(`/api/integration-settings/linear/repos/${owner}/${name}`, {
        method: "DELETE",
      });

      if (res.ok) {
        mutate(REPO_SETTINGS_KEY);
        toast.success(`Override for ${entry.repo} removed.`);
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to delete override");
      }
    } catch {
      toast.error("Failed to delete override");
    }
  };

  return (
    <div className="grid gap-2 px-4 py-3 border border-border rounded-sm">
      <div className="text-sm font-medium text-foreground">{entry.repo}</div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
        <Select value={model} onValueChange={handleModelChange}>
          <SelectTrigger density="compact">
            <SelectValue placeholder="Default model" />
          </SelectTrigger>
          <SelectContent>
            {enabledModelOptions.map((group) => (
              <SelectGroup key={group.category}>
                <SelectLabel>{group.category}</SelectLabel>
                {group.models.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={effort}
          onValueChange={(v) => {
            setEffort(v);
            setDirty(true);
          }}
          disabled={!reasoningConfig}
        >
          <SelectTrigger density="compact">
            <SelectValue placeholder="Default effort" />
          </SelectTrigger>
          <SelectContent>
            {(reasoningConfig?.efforts ?? []).map((value) => (
              <SelectItem key={value} value={value}>
                {value}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <label className="flex items-center justify-between px-2 py-1 text-sm border border-border rounded-sm">
          <span>Tool updates</span>
          <Checkbox
            checked={emitToolProgressActivities}
            onCheckedChange={(checked) => {
              setEmitToolProgressActivities(!!checked);
              setDirty(true);
            }}
          />
        </label>
      </div>

      <div className="grid sm:grid-cols-2 gap-2">
        <label className="flex items-center justify-between px-2 py-1 text-sm border border-border rounded-sm">
          <span>User preference override</span>
          <Checkbox
            checked={allowUserPreferenceOverride}
            onCheckedChange={(checked) => {
              setAllowUserPreferenceOverride(!!checked);
              setDirty(true);
            }}
          />
        </label>
        <label className="flex items-center justify-between px-2 py-1 text-sm border border-border rounded-sm">
          <span>Label model override</span>
          <Checkbox
            checked={allowLabelModelOverride}
            onCheckedChange={(checked) => {
              setAllowLabelModelOverride(!!checked);
              setDirty(true);
            }}
          />
        </label>
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={handleSave} disabled={saving || !dirty}>
          {saving ? "..." : "Save"}
        </Button>

        <Button variant="destructive" size="sm" onClick={handleDelete}>
          Remove
        </Button>
      </div>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="border border-border-muted rounded-md p-5 mb-5">
      <h4 className="text-sm font-semibold uppercase tracking-wider text-foreground mb-1">
        {title}
      </h4>
      <p className="text-sm text-muted-foreground mb-4">{description}</p>
      {children}
    </section>
  );
}

function Message({ tone, text }: { tone: "error" | "success"; text: string }) {
  const classes =
    tone === "error"
      ? "mb-4 bg-red-50 text-red-700 px-4 py-3 border border-red-200 text-sm rounded-sm"
      : "mb-4 bg-green-50 text-green-700 px-4 py-3 border border-green-200 text-sm rounded-sm";

  return (
    <div className={classes} aria-live="polite">
      {text}
    </div>
  );
}
