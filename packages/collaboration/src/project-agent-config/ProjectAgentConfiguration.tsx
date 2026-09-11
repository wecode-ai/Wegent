// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useRef, useState } from "react";

import type { CollaborationTranslate } from "../i18n";
import type { SharedWorkspaceApi } from "../ports/SharedWorkspaceApi";
import type {
  CollaborationExecutionEnvironment,
  CollaborationOwnedAgent,
  CollaborationProject,
} from "../types";
import {
  createCodexProjectAgentInput,
  createWegentProjectAgentInput,
  normalizeProjectAgent,
  type ProjectAgentConfigurationRecord,
} from "./model";
import styles from "./ProjectAgentConfiguration.module.css";

type AgentMode = "wegent" | "codex";

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

function environmentLabel(environment: CollaborationExecutionEnvironment) {
  const kind =
    environment.kind === "cloud_host" ? "云端执行环境" : "本地执行环境";
  return `${environment.name} · ${kind} · ${environment.status}`;
}

export function ProjectAgentConfiguration({
  api,
  project,
  onError,
  translate,
}: {
  api: SharedWorkspaceApi;
  project: CollaborationProject;
  onError(): void;
  translate: CollaborationTranslate;
}) {
  const workspaceId = project.workspace_id;
  const [mode, setMode] = useState<AgentMode>("wegent");
  const [agents, setAgents] = useState<ProjectAgentConfigurationRecord[]>([]);
  const [workspaceAgents, setWorkspaceAgents] = useState<
    CollaborationOwnedAgent[]
  >([]);
  const [environments, setEnvironments] = useState<
    CollaborationExecutionEnvironment[]
  >([]);
  const [selectedTeamId, setSelectedTeamId] = useState("");
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState("");
  const [codexName, setCodexName] = useState("");
  const [capabilityDescription, setCapabilityDescription] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [loading, setLoading] = useState(Boolean(workspaceId));
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
    setEnvironments([]);
    setSelectedTeamId("");
    setSelectedEnvironmentId("");
    setError(null);
    if (!workspaceId || !api.workspaces) {
      setLoading(false);
      return;
    }

    let active = true;
    setLoading(true);
    void Promise.all([
      api.agents.list(project.id),
      api.workspaces.listAgents(workspaceId),
      api.workspaces.listExecutionEnvironments(workspaceId),
    ])
      .then(([nextAgents, nextWorkspaceAgents, nextEnvironments]) => {
        if (!active) return;
        setAgents(
          nextAgents
            .map(normalizeProjectAgent)
            .filter((agent) => agent.status !== "archived"),
        );
        setWorkspaceAgents(
          nextWorkspaceAgents.filter(
            (agent) => agent.status === "available" && Boolean(agent.team_id),
          ),
        );
        setEnvironments(
          nextEnvironments.filter((environment) =>
            Boolean(environment.device_key?.trim()),
          ),
        );
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

  const selectedTeam = useMemo(
    () =>
      workspaceAgents.find(
        (candidate) => String(candidate.team_id) === selectedTeamId,
      ) ?? null,
    [selectedTeamId, workspaceAgents],
  );
  const selectedEnvironment = useMemo(
    () =>
      environments.find(
        (environment) => environment.id === selectedEnvironmentId,
      ) ?? null,
    [environments, selectedEnvironmentId],
  );

  async function createAgent(input: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const created = await api.agents.create(project.id, input);
      setAgents((current) => [...current, normalizeProjectAgent(created)]);
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
    }
  }

  async function createCodexAgent() {
    if (!selectedEnvironment || !codexName.trim()) return;
    const created = await createAgent(
      createCodexProjectAgentInput({
        project,
        environment: selectedEnvironment,
        name: codexName,
        capabilityDescription,
        systemPrompt,
      }),
    );
    if (!created) return;
    setCodexName("");
    setCapabilityDescription("");
    setSystemPrompt("");
    setSelectedEnvironmentId("");
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

  if (!workspaceId) {
    return (
      <section
        className={styles.section}
        data-testid="project-agent-config-missing-workspace"
      >
        <h2 className={styles.title}>
          {translate("todo.project_agents", "项目智能体")}
        </h2>
        <p className={styles.empty}>
          {translate(
            "todo.project_agent_workspace_required",
            "当前项目尚未加入 Workspace，加入后才能配置 Workspace 中的智能体和执行环境。",
          )}
        </p>
      </section>
    );
  }

  if (!api.workspaces) {
    return (
      <section
        className={styles.section}
        data-testid="project-agent-config-workspace-api-missing"
      >
        <h2 className={styles.title}>
          {translate("todo.project_agents", "项目智能体")}
        </h2>
        <p className={styles.empty}>
          {translate(
            "todo.project_agent_workspace_api_required",
            "当前宿主未连接 Workspace 资源，暂时无法配置项目智能体。",
          )}
        </p>
      </section>
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
              "把 Workspace 中已授权的 Wegent 智能体，或绑定执行环境的 Codex 智能体加入当前项目。",
            )}
          </p>
        </div>
      </div>

      {loading ? (
        <p className={styles.empty} data-testid="project-agent-config-loading">
          {translate("common.loading", "加载中…")}
        </p>
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
                  <div className={styles.agentIdentity}>
                    <span className={styles.agentName}>{agent.name}</span>
                    <span className={styles.metadata}>
                      {agent.runtime === "wegent"
                        ? translate(
                            "todo.wegent_managed_agent",
                            "Wegent 托管 · chat_shell",
                          )
                        : `${translate("todo.codex_agent", "Codex 智能体")} · ${
                            agent.executionDeviceId ??
                            translate(
                              "todo.execution_environment_unbound",
                              "未绑定执行环境",
                            )
                          }`}
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

          <div className={styles.composer}>
            <div className={styles.modes}>
              <button
                className={`${styles.modeButton} ${
                  mode === "wegent" ? styles.modeButtonActive : ""
                }`}
                data-testid="project-agent-mode-wegent"
                onClick={() => setMode("wegent")}
                type="button"
              >
                {translate("todo.choose_wegent_agent", "选择 Wegent 智能体")}
              </button>
              <button
                className={`${styles.modeButton} ${
                  mode === "codex" ? styles.modeButtonActive : ""
                }`}
                data-testid="project-agent-mode-codex"
                onClick={() => setMode("codex")}
                type="button"
              >
                {translate("todo.create_codex_agent", "自定义 Codex 智能体")}
              </button>
            </div>

            {mode === "wegent" ? (
              workspaceAgents.length ? (
                <div className={styles.form}>
                  <label className={styles.field}>
                    {translate("todo.workspace_wegent_agent", "Wegent 智能体")}
                    <select
                      className={styles.select}
                      data-testid="project-agent-wegent-team"
                      onChange={(event) =>
                        setSelectedTeamId(event.target.value)
                      }
                      value={selectedTeamId}
                    >
                      <option value="">
                        {translate(
                          "todo.select_workspace_agent",
                          "选择 Workspace 已授权的智能体",
                        )}
                      </option>
                      {workspaceAgents.map((agent) => (
                        <option key={agent.id} value={String(agent.team_id)}>
                          {agent.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className={styles.formFooter}>
                    <p className={styles.hint}>
                      {translate(
                        "todo.wegent_managed_environment_hint",
                        "Wegent 托管执行使用智能体自带的 chat_shell，无需选择执行环境。",
                      )}
                    </p>
                    <button
                      className={styles.primaryButton}
                      data-testid="project-agent-wegent-create"
                      disabled={!selectedTeam || busy}
                      onClick={() => void createWegentAgent()}
                      type="button"
                    >
                      {busy
                        ? translate("common.creating", "创建中…")
                        : translate("todo.add_to_project", "加入项目")}
                    </button>
                  </div>
                </div>
              ) : (
                <p
                  className={styles.empty}
                  data-testid="project-agent-wegent-empty"
                >
                  {translate(
                    "todo.no_workspace_wegent_agents",
                    "当前 Workspace 没有已授权且可用的 Wegent 智能体，请先到 Workspace 的智能体页面授权。",
                  )}
                </p>
              )
            ) : environments.length ? (
              <div className={styles.form}>
                <label className={styles.field}>
                  {translate("todo.agent_name", "智能体名称")}
                  <input
                    className={styles.input}
                    data-testid="project-agent-codex-name"
                    onChange={(event) => setCodexName(event.target.value)}
                    placeholder={translate(
                      "todo.agent_name_placeholder",
                      "例如：Codex 产品工程师",
                    )}
                    value={codexName}
                  />
                </label>
                <label className={styles.field}>
                  {translate("todo.agent_capability", "能力说明")}
                  <textarea
                    className={styles.textarea}
                    data-testid="project-agent-codex-capability"
                    onChange={(event) =>
                      setCapabilityDescription(event.target.value)
                    }
                    placeholder={translate(
                      "todo.agent_capability_placeholder",
                      "说明这个智能体适合完成什么工作",
                    )}
                    value={capabilityDescription}
                  />
                </label>
                <label className={styles.field}>
                  {translate("todo.agent_system_prompt", "提示词")}
                  <textarea
                    className={styles.textarea}
                    data-testid="project-agent-codex-prompt"
                    onChange={(event) => setSystemPrompt(event.target.value)}
                    placeholder={translate(
                      "todo.agent_system_prompt_placeholder",
                      "输入执行任务时使用的角色和约束",
                    )}
                    value={systemPrompt}
                  />
                </label>
                <label className={styles.field}>
                  {translate("todo.execution_environment", "执行环境")}
                  <select
                    className={styles.select}
                    data-testid="project-agent-codex-environment"
                    onChange={(event) =>
                      setSelectedEnvironmentId(event.target.value)
                    }
                    value={selectedEnvironmentId}
                  >
                    <option value="">
                      {translate(
                        "todo.select_execution_environment",
                        "选择 Workspace 执行环境",
                      )}
                    </option>
                    {environments.map((environment) => (
                      <option key={environment.id} value={environment.id}>
                        {environmentLabel(environment)}
                      </option>
                    ))}
                  </select>
                </label>
                <div className={styles.formFooter}>
                  <p className={styles.hint}>
                    {translate(
                      "todo.codex_environment_hint",
                      "任务会在所选执行环境中运行，并绑定当前项目工作区。",
                    )}
                  </p>
                  <button
                    className={styles.primaryButton}
                    data-testid="project-agent-codex-create"
                    disabled={!codexName.trim() || !selectedEnvironment || busy}
                    onClick={() => void createCodexAgent()}
                    type="button"
                  >
                    {busy
                      ? translate("common.creating", "创建中…")
                      : translate("todo.create_project_agent", "创建智能体")}
                  </button>
                </div>
              </div>
            ) : (
              <p
                className={styles.empty}
                data-testid="project-agent-codex-environment-empty"
              >
                {translate(
                  "todo.no_workspace_execution_environments",
                  "当前 Workspace 没有可用执行环境，请先到 Workspace 的执行环境页面添加。",
                )}
              </p>
            )}
          </div>
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
