// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Info, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { CollaborationTranslate } from "../i18n";
import type { SharedWorkspaceApi } from "../ports/SharedWorkspaceApi";
import type { CollaborationOwnedAgent, CollaborationProject } from "../types";
import {
  createSharedAgentBindingInput,
  normalizeProjectAgent,
  type ProjectAgentConfigurationRecord,
} from "./model";
import type {
  ProjectAgentConfigurationHost,
  ProjectAgentMode,
  ProjectAgentSelectOption,
} from "./types";
import styles from "./ProjectAgentConfiguration.module.css";

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
    "id" | "workspace_id" | "project_store"
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
  const usesLocalAgentCreator =
    project.project_store === "local" &&
    !host?.renderAgentCreator &&
    Boolean(host?.renderLocalAgentCreator);
  const usesLocalAgentEditor =
    project.project_store === "local" && Boolean(host?.renderLocalAgentEditor);
  const supportsAgentCreation = Boolean(
    usesLocalAgentCreator || host?.renderAgentCreator,
  );
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
    setAgents([]);
    setWorkspaceAgents([]);
    setSelectedTeamId("");
    setComposerOpen(false);
    setEditingAgentId(null);
    setError(null);
    let active = true;
    setLoading(true);
    const noSelectableResources = { agents: [], execution_environments: [] };
    void Promise.all([
      api.agents.list(project.id),
      // Selectable resources are only needed by the existing-Agent picker.
      supportsExistingAgentSelection
        ? (api.resources?.list() ?? noSelectableResources)
        : noSelectableResources,
      supportsExistingAgentSelection && workspaceId && api.workspaces
        ? api.workspaces.listAgents(workspaceId)
        : [],
    ])
      .then(([nextAgents, personalResources, nextWorkspaceAgents]) => {
        if (!active) return;
        setAgents(
          nextAgents
            .map(normalizeProjectAgent)
            .filter((agent) => agent.status !== "archived"),
        );
        const selectableAgents = new Map<number, CollaborationOwnedAgent>();
        for (const agent of [
          ...personalResources.agents,
          ...nextWorkspaceAgents,
        ]) {
          const matchesProjectLocation =
            project.project_store === "local"
              ? agent.location === "local"
              : agent.location !== "local";
          if (
            matchesProjectLocation &&
            agent.status === "available" &&
            agent.team_id
          ) {
            selectableAgents.set(agent.team_id, agent);
          }
        }
        setWorkspaceAgents([...selectableAgents.values()]);
      })
      .catch((cause) => {
        if (!active) return;
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
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [
    api,
    project.id,
    project.project_store,
    supportsExistingAgentSelection,
    workspaceId,
  ]);

  useEffect(() => {
    if (openComposerRequestId === undefined) return;
    if (canManage) {
      setMode(defaultMode);
      setComposerOpen(true);
    }
    onOpenComposerRequestConsumed?.(openComposerRequestId);
  }, [
    canManage,
    defaultMode,
    onOpenComposerRequestConsumed,
    openComposerRequestId,
  ]);

  useEffect(() => {
    if (!supportsExistingAgentSelection && mode === "existing") {
      setMode("create");
    }
  }, [mode, supportsExistingAgentSelection]);

  useEffect(() => {
    if (!composerOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) setComposerOpen(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [busy, composerOpen]);

  const selectedTeam = useMemo(
    () =>
      workspaceAgents.find(
        (candidate) => String(candidate.team_id) === selectedTeamId,
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
    if (!selectedTeam) return;
    if (await addAgent(createSharedAgentBindingInput(selectedTeam))) {
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
        },
        { rethrow: true },
      )
    ) {
      setMode(defaultMode);
      setComposerOpen(false);
    }
  }

  async function reloadAgents() {
    const nextAgents = await api.agents.list(project.id);
    setAgents(
      nextAgents
        .map(normalizeProjectAgent)
        .filter((item) => item.status !== "archived"),
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
      setAgents((current) => current.filter((item) => item.id !== agent.id));
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
  const dialogDescription = translate(
    "todo.add_project_agent_description",
    "选择已有智能体，或使用资源库表单新建智能体。",
  );
  const closeLabel = translate("common.close", "关闭");

  function renderSelectControl({
    ariaLabel,
    onChange,
    options,
    placeholder,
    testId,
    value,
  }: {
    ariaLabel: string;
    onChange(value: string): void;
    options: ProjectAgentSelectOption[];
    placeholder: string;
    testId: string;
    value: string;
  }) {
    if (host) {
      return host.renderSelect({
        ariaLabel,
        onChange,
        options,
        placeholder,
        testId,
        value,
      });
    }
    return (
      <select
        aria-label={ariaLabel}
        className={styles.select}
        data-testid={testId}
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        <option value="">{placeholder}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }

  function renderPrimaryAction({
    children,
    disabled,
    onClick,
    testId,
  }: {
    children: ReactNode;
    disabled: boolean;
    onClick(): void;
    testId: string;
  }) {
    if (host) {
      return host.renderPrimaryAction({
        children,
        disabled,
        onClick,
        testId,
      });
    }
    return (
      <button
        className={styles.primaryButton}
        data-testid={testId}
        disabled={disabled}
        onClick={onClick}
        type="button"
      >
        {children}
      </button>
    );
  }

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
          <h2 className={styles.title}>
            {scope === "workspace"
              ? translate("todo.workspace_agents", "空间智能体")
              : translate("todo.project_agents", "项目智能体")}
          </h2>
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
        {canManage ? (
          <button
            className={styles.addButton}
            data-testid="project-agent-add"
            disabled={loading}
            onClick={() => {
              setMode(defaultMode);
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
      ) : (
        <>
          <div className={styles.sectionHeading}>
            <h3>
              {scope === "workspace"
                ? translate("todo.configured_workspace_agents", "已添加智能体")
                : translate("todo.configured_project_agents", "已配置智能体")}
            </h3>
            <span>{agents.length}</span>
          </div>
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
                  {canManage ? (
                    <div className={styles.agentActions}>
                      {canEditAgentResource &&
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
            ? customAgentCreator
              ? customAgentCreator
              : renderDialog(
                  <div
                    className={`${styles.composer} ${
                      host ? styles.hostComposer : ""
                    }`}
                  >
                    {host
                      ? host.renderModePicker({
                          onChange: setMode,
                          options: [
                            {
                              description: translate(
                                "todo.choose_existing_agent_description",
                                "从我的智能体或空间共享智能体中选择",
                              ),
                              label: translate(
                                "todo.choose_existing_agent",
                                "已有智能体",
                              ),
                              testId: "project-agent-mode-existing",
                              value: "existing",
                            },
                            ...(supportsAgentCreation
                              ? [
                                  {
                                    description: translate(
                                      "todo.create_agent_description",
                                      "使用资源库智能体表单",
                                    ),
                                    label: translate(
                                      "todo.create_agent",
                                      "新建智能体",
                                    ),
                                    testId: "project-agent-mode-create",
                                    value: "create" as const,
                                  },
                                ]
                              : []),
                          ],
                          value: mode,
                        })
                      : null}

                    {workspaceAgents.length ? (
                      <div className={styles.form}>
                        <label className={styles.field}>
                          {translate("todo.workspace_wegent_agent", "智能体")}
                          {renderSelectControl({
                            ariaLabel: translate(
                              "todo.workspace_wegent_agent",
                              "智能体",
                            ),
                            onChange: setSelectedTeamId,
                            options: workspaceAgents.map((agent) => ({
                              label: agent.name,
                              value: String(agent.team_id),
                            })),
                            placeholder: translate(
                              "todo.select_workspace_agent",
                              "选择智能体",
                            ),
                            testId: "project-agent-wegent-team",
                            value: selectedTeamId,
                          })}
                        </label>
                        <div className={styles.formFooter}>
                          <p className={styles.hint}>
                            {translate(
                              "todo.shared_agent_execution_hint",
                              "所选智能体保留自身执行器与能力配置，具体运行环境在任务开始时解析。",
                            )}
                          </p>
                          {renderPrimaryAction({
                            children: busy
                              ? translate("common.creating", "创建中…")
                              : scope === "workspace"
                                ? translate("todo.add_to_workspace", "加入空间")
                                : translate("todo.add_to_project", "加入项目"),
                            disabled: !selectedTeam || busy,
                            onClick: () => void addExistingAgent(),
                            testId: "project-agent-wegent-create",
                          })}
                        </div>
                      </div>
                    ) : (
                      <p
                        className={styles.composerEmpty}
                        data-testid="project-agent-wegent-empty"
                      >
                        <Info aria-hidden="true" />
                        <span>
                          {translate(
                            "todo.no_workspace_wegent_agents",
                            supportsAgentCreation
                              ? "当前没有可添加的智能体，可以新建一个。"
                              : "当前没有智能体。请先在资源库创建，或让空间管理员共享智能体。",
                          )}
                        </span>
                      </p>
                    )}
                    {error ? (
                      <p
                        role="alert"
                        className={styles.error}
                        data-testid="project-agent-dialog-error"
                      >
                        {error}
                      </p>
                    ) : null}
                  </div>,
                )
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
