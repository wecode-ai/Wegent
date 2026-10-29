// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { CollaborationTranslate } from "../i18n";
import type { SharedWorkspaceApi } from "../ports/SharedWorkspaceApi";
import type { CollaborationOwnedAgent, CollaborationProject } from "../types";
import {
  createResourceAgentBindingInput,
  isSelectableAgentResource,
  normalizeProjectAgent,
  type ProjectAgentConfigurationRecord,
} from "./model";
import type { ProjectAgentConfigurationHost, ProjectAgentMode } from "./types";
import styles from "./ProjectAgentConfiguration.module.css";
import { ProjectAgentPicker } from "./ProjectAgentPicker";

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

export function ProjectAgentConfiguration({
  api,
  canManage = true,
  host,
  project,
  resourceContext,
  onError,
  onAgentsChange,
  openComposerRequestId,
  onOpenComposerRequestConsumed,
  scope = "project",
  translate,
}: {
  api: SharedWorkspaceApi;
  canManage?: boolean;
  host?: ProjectAgentConfigurationHost;
  project: Pick<
    CollaborationProject,
    "id" | "workspace_id" | "project_store" | "workspace_access_role"
  > & {
    name?: string;
    namespace?: string;
  };
  resourceContext?: {
    name: string;
    namespace: string;
  };
  onError(): void;
  onAgentsChange?(): void;
  openComposerRequestId?: number;
  onOpenComposerRequestConsumed?(requestId: number): void;
  scope?: "project" | "workspace";
  translate: CollaborationTranslate;
}) {
  const workspaceId = project.workspace_id;
  const [legacySourceAccess, setLegacySourceAccess] = useState<{
    workspaceId: string;
    allowed: boolean;
  } | null>(null);
  const canBrowseSources =
    canManage &&
    (scope === "workspace" ||
      project.project_store === "local" ||
      Boolean(project.workspace_access_role) ||
      (project.workspace_access_role === undefined &&
        legacySourceAccess?.workspaceId === workspaceId &&
        legacySourceAccess?.allowed === true));
  const legacySourceAccessPending =
    canManage &&
    scope === "project" &&
    project.project_store !== "local" &&
    project.workspace_access_role === undefined &&
    Boolean(workspaceId && api.workspaces) &&
    legacySourceAccess?.workspaceId !== workspaceId;
  const usesLocalAgentCreator =
    project.project_store === "local" && Boolean(host?.renderLocalAgentCreator);
  const usesLocalAgentEditor =
    project.project_store === "local" && Boolean(host?.renderLocalAgentEditor);
  const supportsAgentCreation =
    canBrowseSources &&
    Boolean(usesLocalAgentCreator || host?.renderAgentCreator);
  const supportsExistingAgentSelection =
    host?.supportsExistingAgentSelection ?? true;
  const defaultMode: ProjectAgentMode = supportsExistingAgentSelection
    ? "existing"
    : "create";
  const [mode, setMode] = useState<ProjectAgentMode>(defaultMode);
  const [agents, setAgents] = useState<ProjectAgentConfigurationRecord[]>([]);
  const [workspaceAgents, setWorkspaceAgents] = useState<
    CollaborationOwnedAgent[]
  >([]);
  const [selectedTeamId, setSelectedTeamId] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadRevision, setLoadRevision] = useState(0);
  const [candidateLoading, setCandidateLoading] = useState(true);
  const [candidateError, setCandidateError] = useState<string | null>(null);
  const [candidateRevision, setCandidateRevision] = useState(0);
  const [composerOpen, setComposerOpen] = useState(false);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const onErrorRef = useRef(onError);
  const translateRef = useRef(translate);
  onErrorRef.current = onError;
  translateRef.current = translate;

  useEffect(() => {
    if (
      !canManage ||
      scope === "workspace" ||
      project.project_store === "local" ||
      project.workspace_access_role !== undefined ||
      !workspaceId ||
      !api.workspaces
    )
      return;
    let active = true;
    void api.workspaces
      .list()
      .then((workspaces) => {
        if (active)
          setLegacySourceAccess({
            workspaceId,
            allowed: workspaces.some(
              (workspace) => workspace.id === workspaceId,
            ),
          });
      })
      .catch((cause) => {
        if (!active) return;
        setLegacySourceAccess({ workspaceId, allowed: false });
        setError(
          errorMessage(
            cause,
            translateRef.current(
              "todo.load_project_agents_failed",
              "加载项目智能体配置失败",
            ),
          ),
        );
        onErrorRef.current();
      });
    return () => {
      active = false;
    };
  }, [
    api,
    canManage,
    scope,
    project.project_store,
    project.workspace_access_role,
    workspaceId,
  ]);

  useEffect(() => {
    setAgents([]);
    setWorkspaceAgents([]);
    setCandidateError(null);
    setSelectedTeamId("");
    setComposerOpen(false);
    setEditingAgentId(null);
    setError(null);
    setLoadError(null);
    let active = true;
    setLoading(true);
    void api.agents
      .list(project.id, {
        includeArchived: canManage && scope === "project",
      })
      .then((nextAgents) => {
        if (!active) return;
        setAgents(
          nextAgents
            .map(normalizeProjectAgent)
            .filter((agent) => canManage || agent.status !== "archived"),
        );
      })
      .catch((cause) => {
        if (!active) return;
        setLoadError(
          errorMessage(
            cause,
            translateRef.current(
              "todo.load_project_agents_failed",
              "加载项目智能体配置失败",
            ),
          ),
        );
        onErrorRef.current();
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, project.id, canManage, scope, loadRevision]);

  useEffect(() => {
    if (
      !composerOpen ||
      mode !== "existing" ||
      !canBrowseSources ||
      !supportsExistingAgentSelection
    )
      return;
    let active = true;
    setCandidateLoading(true);
    setCandidateError(null);
    void Promise.all([
      api.resources?.list() ?? { agents: [], execution_environments: [] },
      workspaceId && api.workspaces
        ? api.workspaces.listAgents(workspaceId)
        : [],
    ])
      .then(([personalResources, nextWorkspaceAgents]) => {
        if (!active) return;
        const selectable = new Map<string, CollaborationOwnedAgent>();
        for (const agent of [
          ...personalResources.agents,
          ...nextWorkspaceAgents,
        ]) {
          const matchesLocation =
            project.project_store === "local"
              ? agent.location === "local"
              : agent.location !== "local";
          if (
            matchesLocation &&
            isSelectableAgentResource(agent) &&
            (agent.team_id || agent.project_binding_input)
          )
            selectable.set(String(agent.team_id ?? agent.id), agent);
        }
        setWorkspaceAgents([...selectable.values()]);
      })
      .catch((cause) => {
        if (!active) return;
        setCandidateError(
          errorMessage(
            cause,
            translateRef.current(
              "todo.load_project_agents_failed",
              "加载项目智能体配置失败",
            ),
          ),
        );
        onErrorRef.current();
      })
      .finally(() => {
        if (active) setCandidateLoading(false);
      });
    return () => {
      active = false;
    };
  }, [
    api,
    composerOpen,
    mode,
    canBrowseSources,
    supportsExistingAgentSelection,
    workspaceId,
    project.project_store,
    candidateRevision,
  ]);

  useEffect(() => {
    if (openComposerRequestId === undefined || legacySourceAccessPending)
      return;
    if (canBrowseSources) {
      setMode(defaultMode);
      setSelectedTeamId("");
      setCandidateLoading(true);
      setCandidateError(null);
      setError(null);
      setComposerOpen(true);
    }
    onOpenComposerRequestConsumed?.(openComposerRequestId);
  }, [
    canBrowseSources,
    defaultMode,
    legacySourceAccessPending,
    onOpenComposerRequestConsumed,
    openComposerRequestId,
  ]);

  useEffect(() => {
    if (!supportsExistingAgentSelection && mode === "existing") {
      setMode("create");
    }
  }, [mode, supportsExistingAgentSelection]);

  useEffect(() => {
    if (!composerOpen || host) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) setComposerOpen(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [busy, composerOpen, host]);

  const selectedTeam = useMemo(
    () =>
      workspaceAgents.find(
        (candidate) =>
          String(candidate.team_id ?? candidate.id) === selectedTeamId,
      ) ?? null,
    [selectedTeamId, workspaceAgents],
  );

  const editingAgent = useMemo(
    () => agents.find((candidate) => candidate.id === editingAgentId) ?? null,
    [agents, editingAgentId],
  );

  async function addAgent(
    input: Record<string, unknown>,
    options: { rethrow?: boolean } = {},
  ) {
    setBusy(true);
    setError(null);
    try {
      const created = await api.agents.create(project.id, input);
      setAgents((current) => [...current, normalizeProjectAgent(created)]);
      onAgentsChange?.();
      return true;
    } catch (cause) {
      setError(
        errorMessage(
          cause,
          translate("todo.create_project_agent_failed", "创建项目智能体失败"),
        ),
      );
      onError();
      if (options.rethrow) throw cause;
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function addExistingAgent() {
    if (
      !selectedTeam ||
      agents.some(
        (agent) =>
          selectedTeam.team_id != null &&
          agent.wegentTeamId === selectedTeam.team_id,
      )
    )
      return;
    if (await addAgent(createResourceAgentBindingInput(selectedTeam))) {
      setSelectedTeamId("");
      setComposerOpen(false);
    }
  }

  async function createAndAddAgent(agent: { name: string; teamId: number }) {
    if (
      await addAgent(
        {
          name: agent.name,
          runtime: "wegent",
          wegentTeamId: agent.teamId,
          shareWithWorkspace: true,
        },
        { rethrow: true },
      )
    ) {
      setMode(defaultMode);
      setComposerOpen(false);
    }
  }

  async function reloadAgents() {
    const nextAgents = await api.agents.list(project.id, {
      includeArchived: canManage && scope === "project",
    });
    setAgents(
      nextAgents
        .map(normalizeProjectAgent)
        .filter((item) => canManage || item.status !== "archived"),
    );
  }

  async function finishLocalAgentCreation() {
    setError(null);
    try {
      await reloadAgents();
      setMode(defaultMode);
      setComposerOpen(false);
      onAgentsChange?.();
    } catch (cause) {
      setError(
        errorMessage(
          cause,
          translate(
            "todo.load_project_agents_failed",
            "加载项目智能体配置失败",
          ),
        ),
      );
      onError();
      throw cause;
    }
  }

  async function archiveAgent(agent: ProjectAgentConfigurationRecord) {
    setArchivingId(agent.id);
    setError(null);
    try {
      await api.agents.update(project.id, agent.id, {
        version: agent.version,
        status: "archived",
      });
      await reloadAgents();
      onAgentsChange?.();
    } catch (cause) {
      setError(
        errorMessage(
          cause,
          translate("todo.archive_project_agent_failed", "停用项目智能体失败"),
        ),
      );
      onError();
    } finally {
      setArchivingId(null);
    }
  }

  async function saveEditedAgent(saved: { name: string; teamId: number }) {
    const agent = editingAgent;
    if (!agent) return;
    setError(null);
    try {
      // Project rows refresh their materialized Agent configuration after the
      // backing resource changes; workspace rows derive it on read.
      if (scope === "project") {
        await api.agents.update(project.id, agent.id, {
          version: agent.version,
          ...(saved.name ? { name: saved.name } : {}),
        });
      }
      await reloadAgents();
      setEditingAgentId(null);
      onAgentsChange?.();
    } catch (cause) {
      setError(
        errorMessage(
          cause,
          translate("todo.update_project_agent_failed", "更新项目智能体失败"),
        ),
      );
      onError();
      throw cause;
    }
  }

  const dialogTitle = translate("todo.add_project_agent", "添加智能体");
  const dialogDescription =
    scope === "workspace"
      ? translate(
          "todo.agent_picker_workspace_description",
          "选择一个智能体，供空间内项目复用。",
        )
      : translate(
          "todo.agent_picker_description",
          "选择一个智能体，加入后即可分配项目任务。",
        );
  const closeLabel = translate("common.close", "关闭");

  function renderDialog(children: ReactNode) {
    if (host) {
      return host.renderDialog({
        busy,
        children,
        closeLabel,
        description: dialogDescription,
        onClose: () => setComposerOpen(false),
        testIds: {
          backdrop: "project-agent-dialog-backdrop",
          close: "project-agent-dialog-close",
          dialog: "project-agent-dialog",
        },
        title: dialogTitle,
      });
    }
    return (
      <div
        className={styles.modalBackdrop}
        data-testid="project-agent-dialog-backdrop"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget && !busy) {
            setComposerOpen(false);
          }
        }}
      >
        <section
          aria-labelledby="project-agent-dialog-title"
          aria-modal="true"
          className={styles.modal}
          data-testid="project-agent-dialog"
          role="dialog"
        >
          <header className={styles.modalHeader}>
            <div className={styles.composerHeader}>
              <h3 id="project-agent-dialog-title">{dialogTitle}</h3>
              <p>{dialogDescription}</p>
            </div>
            <button
              aria-label={closeLabel}
              className={styles.closeButton}
              data-testid="project-agent-dialog-close"
              disabled={busy}
              onClick={() => setComposerOpen(false)}
              type="button"
            >
              <X aria-hidden="true" />
            </button>
          </header>
          {children}
        </section>
      </div>
    );
  }

  const creatorContext = resourceContext ?? {
    name: project.name ?? "",
    namespace: project.namespace ?? "default",
  };
  const localAgentProjectId = scope === "project" ? project.id : undefined;
  const canEditAgentResource = Boolean(
    host?.renderLocalAgentEditor || host?.renderAgentEditor,
  );

  function renderCustomAgentCreator() {
    if (mode !== "create") return null;
    const onClose = () => {
      setMode(defaultMode);
      setComposerOpen(false);
    };
    if (usesLocalAgentCreator && host?.renderLocalAgentCreator) {
      return host.renderLocalAgentCreator({
        onClose,
        onCreated: finishLocalAgentCreation,
        projectId: localAgentProjectId,
      });
    }
    return host?.renderAgentCreator?.({
      projectId: scope === "project" ? project.id : undefined,
      namespace: creatorContext.namespace,
      onClose,
      onCreated: createAndAddAgent,
      workspaceName: creatorContext.name,
    });
  }

  const customAgentCreator = composerOpen ? renderCustomAgentCreator() : null;

  return (
    <section className={styles.section} data-testid="project-agent-config">
      <div className={styles.header}>
        <div>
          <div className={styles.titleRow}>
            <h2 className={styles.title}>
              {scope === "workspace"
                ? translate("todo.workspace_agents", "空间智能体")
                : translate("todo.project_agents", "项目智能体")}
            </h2>
            {!loading && !loadError ? (
              <span className={styles.count}>{agents.length}</span>
            ) : null}
          </div>
          <p className={styles.description}>
            {scope === "workspace"
              ? translate(
                  "todo.workspace_agents_description",
                  "管理空间共享智能体，空间内项目可以直接复用。",
                )
              : translate(
                  "todo.project_agents_description",
                  "直接管理这个项目的智能体；既可使用我的智能体，也可复用空间共享的智能体。",
                )}
          </p>
        </div>
        {canBrowseSources ? (
          <button
            className={styles.addButton}
            data-testid="project-agent-add"
            disabled={loading || loadError !== null}
            onClick={() => {
              setMode(defaultMode);
              setSelectedTeamId("");
              setCandidateLoading(true);
              setCandidateError(null);
              setError(null);
              setComposerOpen(true);
            }}
            type="button"
          >
            {translate("todo.add_project_agent", "添加智能体")}
          </button>
        ) : null}
      </div>

      {loading ? (
        <p className={styles.empty} data-testid="project-agent-config-loading">
          {translate("common.loading", "加载中…")}
        </p>
      ) : loadError ? (
        <div
          role="alert"
          className={styles.error}
          data-testid="project-agent-config-error"
        >
          {loadError}
          <button
            type="button"
            className={styles.retryButton}
            data-testid="project-agent-config-retry"
            onClick={() => setLoadRevision((value) => value + 1)}
          >
            {translate("common.retry", "重试")}
          </button>
        </div>
      ) : (
        <>
          {agents.length ? (
            <div className={styles.list} data-testid="project-agent-list">
              {agents.map((agent) => (
                <div
                  className={styles.agent}
                  data-testid={`project-agent-row-${agent.id}`}
                  key={agent.id}
                >
                  <span className={styles.agentAvatar} aria-hidden="true">
                    {agent.displayName.trim().slice(0, 1).toUpperCase() || "AI"}
                  </span>
                  <div className={styles.agentIdentity}>
                    <span className={styles.agentName}>
                      {agent.displayName}
                    </span>
                    <span className={styles.agentDetails}>
                      <span className={styles.runtimeBadge}>
                        {agent.executorType === null
                          ? translate(
                              "todo.agent_executor_from_definition",
                              "执行器由智能体定义",
                            )
                          : agent.executorType === "claude_code"
                            ? "Claude Code"
                            : translate("todo.codex_agent", "Codex")}
                      </span>
                      <span className={styles.metadata}>
                        {agent.definitionSource === "shared_agent"
                          ? translate("todo.shared_agent", "共享智能体")
                          : agent.capabilityDescription ||
                            translate("todo.project_owned_agent", "项目智能体")}
                      </span>
                      {agent.definitionSource === "project" ? (
                        <span
                          className={styles.capabilitySummary}
                          data-testid={`project-agent-capabilities-${agent.id}`}
                        >
                          {agent.additionalSkills.length} Skill · 项目空间 MCP
                          {Object.keys(agent.mcpServers).length
                            ? ` + ${Object.keys(agent.mcpServers).length} MCP`
                            : ""}
                        </span>
                      ) : null}
                    </span>
                  </div>
                  {agent.status === "archived" || !agent.canUse ? (
                    <span data-testid={`project-agent-unavailable-${agent.id}`}>
                      {agent.status === "archived"
                        ? translate("todo.agent_disabled", "已停用")
                        : agent.unavailableReason
                          ? translate(
                              "todo.agent_authorization_revoked",
                              "资源授权已失效",
                            )
                          : translate(
                              "todo.agent_permission_readonly",
                              "只读账号无法执行",
                            )}
                      {agent.unavailableReason === "resource_sharing_required"
                        ? translate(
                            "todo.agent_resource_sharing_required",
                            "需要资源所有者共享到空间",
                          )
                        : agent.unavailableReason ===
                            "private_binding_requires_explicit_share"
                          ? translate(
                              "todo.agent_private_share_required",
                              "原私有绑定需要明确共享后启用",
                            )
                          : ""}
                    </span>
                  ) : null}
                  {canManage ? (
                    <div className={styles.agentActions}>
                      {scope === "project" && agent.status === "archived" ? (
                        <button
                          type="button"
                          data-testid={`project-agent-reactivate-${agent.id}`}
                          disabled={archivingId === agent.id}
                          onClick={() => {
                            setArchivingId(agent.id);
                            setError(null);
                            void api.agents
                              .update(project.id, agent.id, {
                                version: agent.version,
                                status: "active",
                                shareWithWorkspace: true,
                              })
                              .then(reloadAgents)
                              .then(() => onAgentsChange?.())
                              .catch((cause) => {
                                setError(
                                  errorMessage(
                                    cause,
                                    translate(
                                      "todo.update_project_agent_failed",
                                      "更新项目智能体失败",
                                    ),
                                  ),
                                );
                                onError();
                              })
                              .finally(() => setArchivingId(null));
                          }}
                        >
                          {translate(
                            "todo.agent_reactivate_share",
                            "授权并重新启用",
                          )}
                        </button>
                      ) : null}
                      {canEditAgentResource &&
                      agent.canEdit &&
                      ((agent.definitionSource === "project" &&
                        usesLocalAgentEditor) ||
                        (agent.definitionSource === "shared_agent" &&
                          agent.wegentTeamId !== null)) ? (
                        <button
                          className={styles.archiveButton}
                          data-testid={`project-agent-edit-${agent.id}`}
                          disabled={archivingId === agent.id}
                          onClick={() => setEditingAgentId(agent.id)}
                          type="button"
                        >
                          {translate("todo.edit_project_agent", "编辑")}
                        </button>
                      ) : null}
                      {agent.deletable && agent.status !== "archived" ? (
                        <button
                          className={styles.archiveButton}
                          data-testid={`project-agent-archive-${agent.id}`}
                          disabled={archivingId === agent.id}
                          onClick={() => void archiveAgent(agent)}
                          type="button"
                        >
                          {archivingId === agent.id
                            ? translate("common.saving", "处理中…")
                            : scope === "workspace"
                              ? translate(
                                  "todo.remove_workspace_agent",
                                  "移出空间",
                                )
                              : translate("todo.archive_project_agent", "停用")}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <p className={styles.empty} data-testid="project-agent-list-empty">
              {translate(
                scope === "workspace"
                  ? "todo.no_workspace_agents"
                  : "todo.no_project_agents",
                scope === "workspace"
                  ? "当前空间还没有智能体。"
                  : "当前项目还没有智能体。",
              )}
            </p>
          )}

          {composerOpen
            ? (customAgentCreator ??
              renderDialog(
                <ProjectAgentPicker
                  agents={workspaceAgents}
                  addedTeamIds={
                    new Set(
                      agents.flatMap((agent) =>
                        agent.wegentTeamId === null ? [] : [agent.wegentTeamId],
                      ),
                    )
                  }
                  selectedId={selectedTeamId}
                  loading={candidateLoading}
                  loadError={candidateError}
                  error={error}
                  busy={busy}
                  scope={scope}
                  translate={translate}
                  onSelect={setSelectedTeamId}
                  onRetry={() => setCandidateRevision((value) => value + 1)}
                  onCreate={
                    supportsAgentCreation ? () => setMode("create") : undefined
                  }
                  onClose={() => setComposerOpen(false)}
                  onAdd={() => void addExistingAgent()}
                />,
              ))
            : null}

          {editingAgent &&
          editingAgent.definitionSource === "project" &&
          usesLocalAgentEditor &&
          host?.renderLocalAgentEditor
            ? host.renderLocalAgentEditor({
                projectId: localAgentProjectId,
                resourceId: editingAgent.id,
                onClose: () => setEditingAgentId(null),
                onSaved: async () => {
                  await reloadAgents();
                  setEditingAgentId(null);
                  onAgentsChange?.();
                },
              })
            : editingAgent &&
                editingAgent.definitionSource === "shared_agent" &&
                editingAgent.wegentTeamId !== null &&
                host?.renderAgentEditor
              ? host.renderAgentEditor({
                  projectId:
                    scope === "project" ? String(project.id) : undefined,
                  agent: { teamId: editingAgent.wegentTeamId },
                  namespace: creatorContext.namespace,
                  onClose: () => setEditingAgentId(null),
                  onSaved: saveEditedAgent,
                  workspaceName: creatorContext.name,
                })
              : null}
        </>
      )}
      {error && !composerOpen ? (
        <p className={styles.error} data-testid="project-agent-config-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}
