// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Info, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { CollaborationTranslate } from "../i18n";
import type {
  SharedWorkspaceApi,
  WorkspaceAutomationModel,
} from "../ports/SharedWorkspaceApi";
import {
  StandardFormGroup,
  StandardFormRow,
  StandardFormSection,
} from "../standard-form";
import type { CollaborationOwnedAgent, CollaborationProject } from "../types";
import {
  createLocalProjectAgentInput,
  createWegentProjectAgentInput,
  normalizeProjectAgent,
  parseProjectAgentSkillRefs,
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
  onError,
  onAgentsChange,
  scope = "project",
  translate,
}: {
  api: SharedWorkspaceApi;
  canManage?: boolean;
  host?: ProjectAgentConfigurationHost;
  project: Pick<CollaborationProject, "id" | "workspace_id" | "project_store">;
  onError(): void;
  onAgentsChange?(): void;
  scope?: "project" | "workspace";
  translate: CollaborationTranslate;
}) {
  const workspaceId = project.workspace_id;
  const supportsNativeCreation = scope === "project";
  const existingAgentSelectionDisabled =
    host?.existingAgentSelection?.disabled ?? false;
  const defaultMode: ProjectAgentMode =
    supportsNativeCreation && existingAgentSelectionDisabled
      ? "create"
      : "existing";
  const [mode, setMode] = useState<ProjectAgentMode>(defaultMode);
  const [agents, setAgents] = useState<ProjectAgentConfigurationRecord[]>([]);
  const [workspaceAgents, setWorkspaceAgents] = useState<
    CollaborationOwnedAgent[]
  >([]);
  const [selectedTeamId, setSelectedTeamId] = useState("");
  const [localName, setLocalName] = useState("");
  const [localRuntime, setLocalRuntime] = useState<"codex" | "claude_code">(
    "codex",
  );
  const [models, setModels] = useState<WorkspaceAutomationModel[]>([]);
  const [modelIndex, setModelIndex] = useState("");
  const [capabilityDescription, setCapabilityDescription] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [additionalSkills, setAdditionalSkills] = useState("");
  const [mcpServers, setMcpServers] = useState("{}");
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
    setModels([]);
    setModelIndex("");
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
      (supportsNativeCreation
        ? api.automationExecutionCatalog?.load(project.id)
        : undefined) ??
        Promise.resolve({
          environments: [],
          models: [],
          plugins: [],
        }),
    ])
      .then(
        ([
          nextAgents,
          personalResources,
          nextWorkspaceAgents,
          executionCatalog,
        ]) => {
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
            if (matchesProjectLocation && agent.team_id) {
              selectableAgents.set(agent.team_id, agent);
            }
          }
          setWorkspaceAgents([...selectableAgents.values()]);
          setModels(executionCatalog.models);
          setModelIndex(executionCatalog.models.length ? "0" : "");
        },
      )
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
    supportsNativeCreation,
    workspaceId,
  ]);

  useEffect(() => {
    if (
      supportsNativeCreation &&
      existingAgentSelectionDisabled &&
      mode === "existing"
    ) {
      setMode("create");
    }
  }, [existingAgentSelectionDisabled, mode, supportsNativeCreation]);

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
  const selectedModel =
    modelIndex === "" ? undefined : models[Number(modelIndex)];
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

  async function createLocalAgent() {
    if (!localName.trim() || !selectedModel) return;
    let parsedMcpServers: Record<string, unknown>;
    try {
      const parsed = JSON.parse(mcpServers || "{}");
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
        throw new Error("MCP configuration must be an object");
      }
      parsedMcpServers = parsed as Record<string, unknown>;
    } catch {
      setError(
        translate(
          "todo.invalid_mcp_configuration",
          "MCP 配置必须是有效的 JSON 对象。",
        ),
      );
      return;
    }
    if (
      await createAgent(
        createLocalProjectAgentInput({
          name: localName,
          runtime: localRuntime,
          capabilityDescription,
          model: selectedModel.name,
          modelOptions: selectedModel.options,
          modelType: selectedModel.type,
          systemPrompt,
          additionalSkills: parseProjectAgentSkillRefs(additionalSkills),
          mcpServers: parsedMcpServers,
        }),
      )
    ) {
      setLocalName("");
      setLocalRuntime("codex");
      setModelIndex(models.length ? "0" : "");
      setCapabilityDescription("");
      setSystemPrompt("");
      setAdditionalSkills("");
      setMcpServers("{}");
      setComposerOpen(false);
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

  const dialogTitle = translate("todo.add_project_agent", "添加智能体");
  const dialogDescription = translate(
    "todo.add_project_agent_description",
    "选择已有智能体，或使用标准表单新建智能体。",
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
                    {agent.name.trim().slice(0, 1).toUpperCase() || "AI"}
                  </span>
                  <div className={styles.agentIdentity}>
                    <span className={styles.agentName}>{agent.name}</span>
                    <span className={styles.agentDetails}>
                      <span className={styles.runtimeBadge}>
                        {agent.runtime === "wegent"
                          ? "Wegent"
                          : agent.runtime === "claude_code"
                            ? "Claude Code"
                            : translate("todo.codex_agent", "Codex")}
                      </span>
                      <span className={styles.metadata}>
                        {agent.runtime === "wegent"
                          ? translate("todo.shared_agent", "共享智能体")
                          : agent.capabilityDescription ||
                            translate("todo.project_owned_agent", "项目智能体")}
                      </span>
                      {agent.runtime !== "wegent" ? (
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
                          ? translate("todo.remove_workspace_agent", "移出空间")
                          : translate("todo.archive_project_agent", "停用")}
                    </button>
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
                  : "当前项目还没有智能体。请从下面选择一种方式添加。",
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
                          description:
                            host.existingAgentSelection?.description ??
                            translate(
                              "todo.choose_existing_agent_description",
                              "从我的智能体或空间共享智能体中选择",
                            ),
                          disabled: existingAgentSelectionDisabled,
                          label: translate(
                            "todo.choose_existing_agent",
                            "已有智能体",
                          ),
                          testId: "project-agent-mode-existing",
                          value: "existing",
                        },
                        ...(supportsNativeCreation
                          ? [
                              {
                                description: translate(
                                  "todo.create_agent_description",
                                  "使用标准智能体创建表单",
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
                  ) : (
                    <div className={styles.modes}>
                      <button
                        autoFocus={!existingAgentSelectionDisabled}
                        className={`${styles.modeButton} ${
                          mode === "existing" ? styles.modeButtonActive : ""
                        }`}
                        data-testid="project-agent-mode-existing"
                        disabled={existingAgentSelectionDisabled}
                        onClick={() => setMode("existing")}
                        type="button"
                      >
                        {translate("todo.choose_existing_agent", "已有智能体")}
                      </button>
                      {supportsNativeCreation ? (
                        <button
                          className={`${styles.modeButton} ${
                            mode === "create" ? styles.modeButtonActive : ""
                          }`}
                          data-testid="project-agent-mode-create"
                          onClick={() => setMode("create")}
                          type="button"
                        >
                          {translate("todo.create_agent", "新建智能体")}
                        </button>
                      ) : null}
                    </div>
                  )}

                  {mode === "existing" ? (
                    workspaceAgents.length ? (
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
                              "todo.wegent_managed_environment_hint",
                              "Wegent 托管执行使用智能体自带的 chat_shell，无需选择执行环境。",
                            )}
                          </p>
                          {renderPrimaryAction({
                            children: busy
                              ? translate("common.creating", "创建中…")
                              : scope === "workspace"
                                ? translate("todo.add_to_workspace", "加入空间")
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
                    <div
                      className={styles.standardCreateForm}
                      data-testid="project-agent-standard-create-form"
                    >
                      <StandardFormSection
                        title={translate(
                          "todo.agent_basic_information",
                          "基本信息",
                        )}
                      >
                        <StandardFormGroup>
                          <StandardFormRow
                            description={translate(
                              "todo.agent_name_description",
                              "用于识别和分配工作的智能体名称。",
                            )}
                            label={
                              <>
                                {translate("common.name", "名称")}{" "}
                                <span className={styles.required}>*</span>
                              </>
                            }
                          >
                            {renderTextControl({
                              ariaLabel: translate("common.name", "名称"),
                              onChange: setLocalName,
                              placeholder: translate(
                                "todo.agent_name_placeholder",
                                "例如：代码评审智能体",
                              ),
                              testId: "project-agent-local-name",
                              value: localName,
                            })}
                          </StandardFormRow>
                          <StandardFormRow
                            align="start"
                            description={translate(
                              "todo.capability_description_help",
                              "说明智能体负责什么工作，供分配和自动处理时判断。",
                            )}
                            label={translate("common.description", "描述")}
                          >
                            {renderTextControl({
                              ariaLabel: translate(
                                "common.description",
                                "描述",
                              ),
                              onChange: setCapabilityDescription,
                              placeholder: translate(
                                "todo.capability_description_placeholder",
                                "说明这个智能体负责什么工作",
                              ),
                              testId: "project-agent-local-capability",
                              value: capabilityDescription,
                            })}
                          </StandardFormRow>
                        </StandardFormGroup>
                      </StandardFormSection>
                      <StandardFormSection
                        title={translate(
                          "todo.agent_execution_configuration",
                          "执行方式",
                        )}
                      >
                        <StandardFormGroup>
                          <StandardFormRow
                            description={translate(
                              "todo.agent_runtime_description",
                              "选择由 Codex 或 Claude Code 执行；设备在任务运行时从项目设备池中选择。",
                            )}
                            label={translate("todo.agent_runtime", "执行器")}
                          >
                            {renderSelectControl({
                              ariaLabel: translate(
                                "todo.agent_runtime",
                                "执行器",
                              ),
                              onChange: (value) =>
                                setLocalRuntime(
                                  value === "claude_code"
                                    ? "claude_code"
                                    : "codex",
                                ),
                              options: [
                                { label: "Codex", value: "codex" },
                                {
                                  label: "Claude Code",
                                  value: "claude_code",
                                },
                              ],
                              placeholder: translate(
                                "todo.select_agent_runtime",
                                "选择执行器",
                              ),
                              testId: "project-agent-local-runtime",
                              value: localRuntime,
                            })}
                          </StandardFormRow>
                          <StandardFormRow
                            description={translate(
                              "todo.agent_model_description",
                              "模型属于智能体定义；设备和工作区在任务运行时按项目策略解析。",
                            )}
                            label={translate("common.model", "模型")}
                          >
                            {renderSelectControl({
                              ariaLabel: translate("common.model", "模型"),
                              onChange: setModelIndex,
                              options: models.map((model, index) => ({
                                label: model.label,
                                value: String(index),
                              })),
                              placeholder: translate(
                                "todo.select_agent_model",
                                "选择模型",
                              ),
                              testId: "project-agent-local-model",
                              value: modelIndex,
                            })}
                          </StandardFormRow>
                        </StandardFormGroup>
                      </StandardFormSection>
                      <StandardFormSection
                        title={translate(
                          "todo.agent_prompt_configuration",
                          "提示词",
                        )}
                      >
                        <StandardFormGroup>
                          <StandardFormRow
                            align="start"
                            description={translate(
                              "todo.system_prompt_help",
                              "定义智能体的职责、约束和输出要求。",
                            )}
                            label={translate(
                              "todo.system_prompt",
                              "系统提示词",
                            )}
                          >
                            {renderTextControl({
                              ariaLabel: translate(
                                "todo.system_prompt",
                                "系统提示词",
                              ),
                              multiline: true,
                              onChange: setSystemPrompt,
                              placeholder: translate(
                                "todo.system_prompt_placeholder",
                                "定义智能体的职责、约束和输出要求",
                              ),
                              testId: "project-agent-local-system-prompt",
                              value: systemPrompt,
                            })}
                          </StandardFormRow>
                        </StandardFormGroup>
                      </StandardFormSection>
                      <StandardFormSection
                        title={translate("todo.agent_capabilities", "能力")}
                      >
                        <StandardFormGroup>
                          <div
                            className={styles.platformCapability}
                            data-testid="project-agent-platform-mcp"
                          >
                            <Info aria-hidden="true" />
                            <div>
                              <strong>项目空间 MCP</strong>
                              <p>
                                {translate(
                                  "todo.agent_project_space_mcp_description",
                                  "运行 Issue 时自动提供当前项目、Issue、评论、文件和交付能力，并按执行上下文授权。",
                                )}
                              </p>
                            </div>
                          </div>
                          <StandardFormRow
                            align="start"
                            description={translate(
                              "todo.agent_skills_description",
                              "填写运行时需要加载的 Skill；可使用“命名空间/名称”，多个 Skill 用英文逗号分隔。",
                            )}
                            label="Skill"
                          >
                            {renderTextControl({
                              ariaLabel: "Skill",
                              onChange: setAdditionalSkills,
                              placeholder:
                                "codex/wework-project-space, code-review",
                              testId: "project-agent-local-skills",
                              value: additionalSkills,
                            })}
                          </StandardFormRow>
                          <StandardFormRow
                            align="start"
                            description={translate(
                              "todo.agent_mcp_description",
                              "仅配置项目空间之外的 MCP Server。凭据由运行时按实际执行用户解析。",
                            )}
                            label="MCP"
                          >
                            {renderTextControl({
                              ariaLabel: "MCP",
                              multiline: true,
                              onChange: setMcpServers,
                              placeholder:
                                '{"server":{"command":"node","args":["server.mjs"]}}',
                              testId: "project-agent-local-mcp",
                              value: mcpServers,
                            })}
                          </StandardFormRow>
                        </StandardFormGroup>
                      </StandardFormSection>
                      <div className={styles.formFooter}>
                        <p className={styles.hint}>
                          {translate(
                            "todo.local_agent_environment_hint",
                            "智能体执行时自动使用当前项目可用设备，无需在创建时绑定运行环境。",
                          )}
                        </p>
                        {renderPrimaryAction({
                          children: busy
                            ? translate("common.creating", "创建中…")
                            : translate("todo.create_agent", "创建智能体"),
                          disabled:
                            busy || !localName.trim() || selectedModel == null,
                          onClick: () => void createLocalAgent(),
                          testId: "project-agent-local-create",
                        })}
                      </div>
                    </div>
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
        </>
      )}
      {error && !composerOpen && (
        <p className={styles.error} data-testid="project-agent-config-error">
          {error}
        </p>
      )}
    </section>
  );
}
