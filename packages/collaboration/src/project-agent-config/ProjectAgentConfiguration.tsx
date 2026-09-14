// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Info, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { CollaborationTranslate } from "../i18n";
import type { SharedWorkspaceApi } from "../ports/SharedWorkspaceApi";
import type { CollaborationOwnedAgent, CollaborationProject } from "../types";
import {
  createCodexProjectAgentInput,
  createWegentProjectAgentInput,
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
  host,
  project,
  onError,
  onAgentsChange,
  translate,
}: {
  api: SharedWorkspaceApi;
  host?: ProjectAgentConfigurationHost;
  project: CollaborationProject;
  onError(): void;
  onAgentsChange?(): void;
  translate: CollaborationTranslate;
}) {
  const workspaceId = project.workspace_id;
  const [mode, setMode] = useState<ProjectAgentMode>("wegent");
  const [agents, setAgents] = useState<ProjectAgentConfigurationRecord[]>([]);
  const [workspaceAgents, setWorkspaceAgents] = useState<
    CollaborationOwnedAgent[]
  >([]);
  const [selectedTeamId, setSelectedTeamId] = useState("");
  const [codexName, setCodexName] = useState("");
  const [capabilityDescription, setCapabilityDescription] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [loading, setLoading] = useState(true);
  const [composerOpen, setComposerOpen] = useState(false);
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
    setError(null);
    let active = true;
    setLoading(true);
    void Promise.all([
      api.agents.list(project.id),
      api.resources?.list() ?? { agents: [], execution_environments: [] },
      workspaceId && api.workspaces
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
        const availableAgents = new Map<number, CollaborationOwnedAgent>();
        for (const agent of [
          ...personalResources.agents,
          ...nextWorkspaceAgents,
        ]) {
          if (agent.status === "available" && agent.team_id) {
            availableAgents.set(agent.team_id, agent);
          }
        }
        setWorkspaceAgents([...availableAgents.values()]);
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
  }, [api, project.id, workspaceId]);

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
  async function createAgent(input: Record<string, unknown>) {
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
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function createWegentAgent() {
    if (!selectedTeam) return;
    if (await createAgent(createWegentProjectAgentInput(selectedTeam))) {
      setSelectedTeamId("");
      setComposerOpen(false);
    }
  }

  async function createCodexAgent() {
    if (!codexName.trim()) return;
    const created = await createAgent(
      createCodexProjectAgentInput({
        name: codexName,
        capabilityDescription,
        systemPrompt,
      }),
    );
    if (!created) return;
    setCodexName("");
    setCapabilityDescription("");
    setSystemPrompt("");
    setComposerOpen(false);
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

  const dialogTitle = translate("todo.add_project_agent", "添加智能体");
  const dialogDescription = translate(
    "todo.add_project_agent_description",
    "选择已有智能体，或为当前项目创建专用智能体。",
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

  function renderTextControl({
    ariaLabel,
    multiline,
    onChange,
    placeholder,
    testId,
    value,
  }: {
    ariaLabel: string;
    multiline?: boolean;
    onChange(value: string): void;
    placeholder: string;
    testId: string;
    value: string;
  }) {
    if (host) {
      return host.renderTextControl({
        ariaLabel,
        multiline,
        onChange,
        placeholder,
        testId,
        value,
      });
    }
    if (multiline) {
      return (
        <textarea
          aria-label={ariaLabel}
          className={styles.textarea}
          data-testid={testId}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          value={value}
        />
      );
    }
    return (
      <input
        aria-label={ariaLabel}
        className={styles.input}
        data-testid={testId}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        value={value}
      />
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

  return (
    <section className={styles.section} data-testid="project-agent-config">
      <div className={styles.header}>
        <div>
          <h2 className={styles.title}>
            {translate("todo.project_agents", "项目智能体")}
          </h2>
          <p className={styles.description}>
            {translate(
              "todo.project_agents_description",
              "直接管理这个项目的智能体；既可使用我的智能体，也可复用空间共享的智能体。",
            )}
          </p>
        </div>
        <button
          className={styles.addButton}
          data-testid="project-agent-add"
          disabled={loading}
          onClick={() => setComposerOpen(true)}
          type="button"
        >
          {translate("todo.add_project_agent", "添加智能体")}
        </button>
      </div>

      {loading ? (
        <p className={styles.empty} data-testid="project-agent-config-loading">
          {translate("common.loading", "加载中…")}
        </p>
      ) : (
        <>
          <div className={styles.sectionHeading}>
            <h3>
              {translate("todo.configured_project_agents", "已配置智能体")}
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
                    {agent.name.trim().slice(0, 1).toUpperCase() || "AI"}
                  </span>
                  <div className={styles.agentIdentity}>
                    <span className={styles.agentName}>{agent.name}</span>
                    <span className={styles.agentDetails}>
                      <span className={styles.runtimeBadge}>
                        {agent.runtime === "wegent"
                          ? "Wegent"
                          : translate("todo.codex_agent", "Codex")}
                      </span>
                      <span className={styles.metadata}>
                        {agent.runtime === "wegent"
                          ? translate("todo.shared_agent", "共享智能体")
                          : agent.capabilityDescription ||
                            translate("todo.project_owned_agent", "项目智能体")}
                      </span>
                    </span>
                  </div>
                  <button
                    className={styles.archiveButton}
                    data-testid={`project-agent-archive-${agent.id}`}
                    disabled={archivingId === agent.id}
                    onClick={() => void archiveAgent(agent)}
                    type="button"
                  >
                    {archivingId === agent.id
                      ? translate("common.saving", "处理中…")
                      : translate("todo.archive_project_agent", "停用")}
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className={styles.empty} data-testid="project-agent-list-empty">
              {translate(
                "todo.no_project_agents",
                "当前项目还没有智能体。请从下面选择一种方式添加。",
              )}
            </p>
          )}

          {composerOpen
            ? renderDialog(
                <div
                  className={`${styles.composer} ${
                    host ? styles.hostComposer : ""
                  }`}
                >
                  {host ? (
                    host.renderModePicker({
                      onChange: setMode,
                      options: [
                        {
                          description: translate(
                            "todo.choose_wegent_agent_description",
                            "使用资源库中已有的智能体",
                          ),
                          label: translate(
                            "todo.choose_wegent_agent",
                            "Wegent 智能体",
                          ),
                          testId: "project-agent-mode-wegent",
                          value: "wegent",
                        },
                        {
                          description: translate(
                            "todo.create_codex_agent_description",
                            "配置能力说明和提示词",
                          ),
                          label: translate(
                            "todo.create_codex_agent",
                            "Codex 智能体",
                          ),
                          testId: "project-agent-mode-codex",
                          value: "codex",
                        },
                      ],
                      value: mode,
                    })
                  ) : (
                    <div className={styles.modes}>
                      <button
                        autoFocus
                        className={`${styles.modeButton} ${
                          mode === "wegent" ? styles.modeButtonActive : ""
                        }`}
                        data-testid="project-agent-mode-wegent"
                        onClick={() => setMode("wegent")}
                        type="button"
                      >
                        {translate(
                          "todo.choose_wegent_agent",
                          "选择 Wegent 智能体",
                        )}
                      </button>
                      <button
                        className={`${styles.modeButton} ${
                          mode === "codex" ? styles.modeButtonActive : ""
                        }`}
                        data-testid="project-agent-mode-codex"
                        onClick={() => setMode("codex")}
                        type="button"
                      >
                        {translate(
                          "todo.create_codex_agent",
                          "自定义 Codex 智能体",
                        )}
                      </button>
                    </div>
                  )}

                  {mode === "wegent" ? (
                    workspaceAgents.length ? (
                      <div className={styles.form}>
                        <label className={styles.field}>
                          {translate(
                            "todo.workspace_wegent_agent",
                            "Wegent 智能体",
                          )}
                          {renderSelectControl({
                            ariaLabel: translate(
                              "todo.workspace_wegent_agent",
                              "Wegent 智能体",
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
                              "todo.wegent_managed_environment_hint",
                              "Wegent 托管执行使用智能体自带的 chat_shell，无需选择执行环境。",
                            )}
                          </p>
                          {renderPrimaryAction({
                            children: busy
                              ? translate("common.creating", "创建中…")
                              : translate("todo.add_to_project", "加入项目"),
                            disabled: !selectedTeam || busy,
                            onClick: () => void createWegentAgent(),
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
                            "当前没有智能体。请先在资源库创建，或让空间管理员共享智能体。",
                          )}
                        </span>
                      </p>
                    )
                  ) : (
                    <div className={styles.form}>
                      <label className={styles.field}>
                        {translate("todo.agent_name", "智能体名称")}
                        {renderTextControl({
                          ariaLabel: translate("todo.agent_name", "智能体名称"),
                          onChange: setCodexName,
                          placeholder: translate(
                            "todo.agent_name_placeholder",
                            "例如：Codex 产品工程师",
                          ),
                          testId: "project-agent-codex-name",
                          value: codexName,
                        })}
                      </label>
                      <label className={styles.field}>
                        {translate("todo.agent_capability", "能力说明")}
                        {renderTextControl({
                          ariaLabel: translate(
                            "todo.agent_capability",
                            "能力说明",
                          ),
                          multiline: true,
                          onChange: setCapabilityDescription,
                          placeholder: translate(
                            "todo.agent_capability_placeholder",
                            "说明这个智能体适合完成什么工作",
                          ),
                          testId: "project-agent-codex-capability",
                          value: capabilityDescription,
                        })}
                      </label>
                      <label className={styles.field}>
                        {translate("todo.agent_system_prompt", "提示词")}
                        {renderTextControl({
                          ariaLabel: translate(
                            "todo.agent_system_prompt",
                            "提示词",
                          ),
                          multiline: true,
                          onChange: setSystemPrompt,
                          placeholder: translate(
                            "todo.agent_system_prompt_placeholder",
                            "输入执行任务时使用的角色和约束",
                          ),
                          testId: "project-agent-codex-prompt",
                          value: systemPrompt,
                        })}
                      </label>
                      <div className={styles.formFooter}>
                        <p className={styles.hint}>
                          {translate(
                            "todo.codex_runtime_selection_hint",
                            "运行环境在启动任务时选择，不与智能体绑定。",
                          )}
                        </p>
                        {renderPrimaryAction({
                          children: busy
                            ? translate("common.creating", "创建中…")
                            : translate(
                                "todo.create_project_agent",
                                "创建智能体",
                              ),
                          disabled: !codexName.trim() || busy,
                          onClick: () => void createCodexAgent(),
                          testId: "project-agent-codex-create",
                        })}
                      </div>
                    </div>
                  )}
                </div>,
              )
            : null}
        </>
      )}
      {error && (
        <p className={styles.error} data-testid="project-agent-config-error">
          {error}
        </p>
      )}
    </section>
  );
}
