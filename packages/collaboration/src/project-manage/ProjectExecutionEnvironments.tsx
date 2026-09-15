// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useMemo, useState } from "react";

import type { CollaborationTranslate } from "../i18n";
import {
  executionEnvironmentStatuses,
  executionEnvironmentStatusLabel,
} from "../execution-environment/status";
import type { SharedWorkspaceApi } from "../ports/SharedWorkspaceApi";
import type {
  CollaborationExecutionEnvironment,
  CollaborationExecutionEnvironmentRepository,
  CollaborationExecutionEnvironmentSetupStep,
  CollaborationProject,
  CollaborationWorkspace,
} from "../types";

type RepositoryDraft = CollaborationExecutionEnvironmentRepository & {
  id: string;
};
type SetupStepDraft = CollaborationExecutionEnvironmentSetupStep & {
  id: string;
};

let nextDraftId = 0;

function draftId(prefix: string) {
  nextDraftId += 1;
  return `${prefix}-${nextDraftId}`;
}

type ExecutionEnvironmentScope =
  | {
      project: Pick<
        CollaborationProject,
        | "id"
        | "workspace_id"
        | "access_role"
        | "version"
        | "execution_environment"
      >;
      workspace?: never;
    }
  | {
      project?: never;
      workspace: Pick<
        CollaborationWorkspace,
        "id" | "access_role" | "version" | "execution_environment"
      >;
    };

export function ProjectExecutionEnvironments({
  api,
  project,
  translate,
  workspace,
}: {
  api: SharedWorkspaceApi;
  translate: CollaborationTranslate;
} & ExecutionEnvironmentScope) {
  const isWorkspaceScope = workspace != null;
  const scopeId = workspace?.id ?? project!.id;
  const testIdPrefix = isWorkspaceScope
    ? "collaboration-workspace-execution-environment"
    : "collaboration-project-execution-environment";
  const [workspaceItems, setWorkspaceItems] = useState<
    CollaborationExecutionEnvironment[]
  >([]);
  const [personalItems, setPersonalItems] = useState<
    CollaborationExecutionEnvironment[]
  >([]);
  const [assignedItems, setAssignedItems] = useState<
    CollaborationExecutionEnvironment[]
  >([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const initialConfig =
    workspace?.execution_environment ?? project?.execution_environment;
  const [repositories, setRepositories] = useState<RepositoryDraft[]>(() => {
    const configured = initialConfig?.repositories ?? [];
    return configured.length > 0
      ? configured.map((repository) => ({
          ...repository,
          id: draftId("repository"),
        }))
      : [
          {
            id: draftId("repository"),
            name: "",
            url: "",
            ref: "",
            path: "",
            primary: true,
          },
        ];
  });
  const [setupSteps, setSetupSteps] = useState<SetupStepDraft[]>(() =>
    (initialConfig?.setup_steps ?? []).map((step) => ({
      ...step,
      id: draftId("setup"),
    })),
  );
  const [configVersion, setConfigVersion] = useState(
    workspace?.version ?? project!.version,
  );
  const [configSaved, setConfigSaved] = useState(false);
  const [environmentStatus, setEnvironmentStatus] = useState(
    initialConfig?.status ?? "uninitialized",
  );
  const [preparedDeviceId, setPreparedDeviceId] = useState(
    initialConfig?.prepared_device_id ?? "",
  );
  const [environmentError, setEnvironmentError] = useState(
    initialConfig?.error ?? "",
  );
  const [statusFilter, setStatusFilter] = useState<
    "all" | CollaborationExecutionEnvironment["status"]
  >("all");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [initializingDeviceId, setInitializingDeviceId] = useState<
    number | null
  >(null);
  const [error, setError] = useState("");
  const accessRole = workspace?.access_role ?? project!.access_role;
  const canManage =
    accessRole === "Owner" ||
    accessRole === "Maintainer" ||
    (isWorkspaceScope && accessRole === "Developer");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [assignedEnvironments, personalResources, workspaceEnvironments] =
        await Promise.all([
          isWorkspaceScope
            ? (api.workspaces?.listExecutionEnvironments(scopeId) ?? [])
            : api.projects.listExecutionEnvironments(scopeId),
          api.resources?.list() ?? {
            agents: [],
            execution_environments: [],
          },
          !isWorkspaceScope && project.workspace_id && api.workspaces
            ? api.workspaces.listExecutionEnvironments(project.workspace_id)
            : [],
        ]);
      setWorkspaceItems(workspaceEnvironments);
      setPersonalItems(personalResources.execution_environments);
      setAssignedItems(assignedEnvironments);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : translate(
              "todo.execution_environments_load_failed",
              "加载执行环境失败",
            ),
      );
    } finally {
      setLoading(false);
    }
  }, [api, isWorkspaceScope, project?.workspace_id, scopeId, translate]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedDeviceIds = useMemo(
    () =>
      new Set(
        assignedItems
          .map((environment) => environment.device_id)
          .filter((deviceId): deviceId is number => deviceId != null),
      ),
    [assignedItems],
  );
  const workspaceDeviceIds = useMemo(
    () =>
      new Set(
        workspaceItems
          .map((environment) => environment.device_id)
          .filter((deviceId): deviceId is number => deviceId != null),
      ),
    [workspaceItems],
  );
  const availableItems = useMemo(() => {
    const environments = new Map<number, CollaborationExecutionEnvironment>();
    for (const environment of [...personalItems, ...workspaceItems]) {
      if (environment.device_id != null) {
        environments.set(environment.device_id, environment);
      }
    }
    return [...environments.values()];
  }, [personalItems, workspaceItems]);
  const candidates = availableItems.filter(
    (environment) =>
      environment.device_id != null &&
      environment.status === "online" &&
      !selectedDeviceIds.has(environment.device_id),
  );
  const matchesStatus = (environment: CollaborationExecutionEnvironment) =>
    statusFilter === "all" || environment.status === statusFilter;
  const visibleAssignedItems = assignedItems.filter(matchesStatus);

  function updateRepository(
    id: string,
    patch: Partial<CollaborationExecutionEnvironmentRepository>,
  ) {
    setRepositories((current) =>
      current.map((repository) => {
        if (patch.primary === true) {
          return {
            ...repository,
            primary: repository.id === id,
            ...(repository.id === id ? patch : {}),
          };
        }
        return repository.id === id ? { ...repository, ...patch } : repository;
      }),
    );
    setConfigSaved(false);
  }

  function addRepository() {
    setRepositories((current) => [
      ...current,
      {
        id: draftId("repository"),
        name: "",
        url: "",
        ref: "",
        path: "",
        primary: current.length === 0,
      },
    ]);
    setConfigSaved(false);
  }

  function removeRepository(id: string) {
    setRepositories((current) => {
      const remaining = current.filter((repository) => repository.id !== id);
      if (
        remaining.length > 0 &&
        !remaining.some((repository) => repository.primary)
      ) {
        remaining[0] = { ...remaining[0], primary: true };
      }
      return remaining;
    });
    setConfigSaved(false);
  }

  function updateSetupStep(
    id: string,
    patch: Partial<CollaborationExecutionEnvironmentSetupStep>,
  ) {
    setSetupSteps((current) =>
      current.map((step) => (step.id === id ? { ...step, ...patch } : step)),
    );
    setConfigSaved(false);
  }

  async function addEnvironment(
    environment: CollaborationExecutionEnvironment,
  ) {
    const deviceId = environment.device_id;
    if (deviceId == null || saving) return;
    setSaving(true);
    setError("");
    try {
      const created = isWorkspaceScope
        ? await api.workspaces!.addExecutionEnvironment(scopeId, { deviceId })
        : await api.projects.addExecutionEnvironment(scopeId, deviceId);
      setAssignedItems((current) => [...current, created]);
      setPickerOpen(false);
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : translate("todo.execution_device_add_failed", "添加设备失败"),
      );
    } finally {
      setSaving(false);
    }
  }

  async function removeEnvironment(
    environment: CollaborationExecutionEnvironment,
  ) {
    if (environment.device_id == null) return;
    setSaving(true);
    setError("");
    try {
      if (isWorkspaceScope) {
        await api.workspaces!.removeExecutionEnvironment(
          scopeId,
          environment.device_id,
        );
      } else {
        await api.projects.removeExecutionEnvironment(
          scopeId,
          environment.device_id,
        );
      }
      setAssignedItems((current) =>
        current.filter((item) => item.id !== environment.id),
      );
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : translate(
              "todo.execution_environment_remove_failed",
              "移除执行环境失败",
            ),
      );
    } finally {
      setSaving(false);
    }
  }

  async function createEnvironmentOnDevice(
    device: CollaborationExecutionEnvironment,
  ) {
    if (saving || device.device_id == null || device.status !== "online")
      return;
    setSaving(true);
    setInitializingDeviceId(device.device_id);
    setError("");
    setConfigSaved(false);
    const executionEnvironment = {
      repositories: repositories
        .map(({ id: _id, ...repository }) => ({
          ...repository,
          name: repository.name.trim(),
          url: repository.url.trim(),
          ref: repository.ref.trim(),
          path: repository.path.trim(),
        }))
        .filter((repository) => repository.url && repository.path),
      setupSteps: setupSteps
        .map(({ id: _id, ...step }) => ({
          command: step.command.trim(),
          workingDirectory: step.working_directory.trim(),
        }))
        .filter((step) => step.command),
    };
    try {
      setEnvironmentStatus("preparing");
      setEnvironmentError("");
      const updated = isWorkspaceScope
        ? await api.workspaces!.update(scopeId, {
            version: configVersion,
            executionEnvironment,
          })
        : await api.projects.update(scopeId, {
            version: configVersion,
            executionEnvironment,
          });
      const initialized = isWorkspaceScope
        ? await api.workspaces!.initializeExecutionEnvironment(scopeId, {
            deviceId: device.device_id,
            version: updated.version,
          })
        : await api.projects.initializeExecutionEnvironment(scopeId, {
            deviceId: device.device_id,
            version: updated.version,
          });
      const initializedConfig = initialized.execution_environment;
      setConfigVersion(initialized.version);
      setEnvironmentStatus(initializedConfig?.status ?? "error");
      setPreparedDeviceId(initializedConfig?.prepared_device_id ?? "");
      setEnvironmentError(initializedConfig?.error ?? "");
      if (initializedConfig?.status !== "ready") {
        throw new Error(
          initializedConfig?.error ||
            translate(
              "todo.execution_environment_initialization_failed",
              "执行环境初始化失败",
            ),
        );
      }
      setConfigSaved(true);
    } catch (saveError) {
      setEnvironmentStatus("error");
      setEnvironmentError(
        saveError instanceof Error ? saveError.message : String(saveError),
      );
      setError(
        saveError instanceof Error
          ? saveError.message
          : translate(
              "todo.execution_environment_config_save_failed",
              "保存环境配置失败",
            ),
      );
    } finally {
      setSaving(false);
      setInitializingDeviceId(null);
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-8 py-7">
      <div className="mx-auto max-w-[840px]">
        <h1 className="text-heading-lg font-semibold">
          {translate(
            isWorkspaceScope
              ? "todo.workspace_execution_environments"
              : "todo.project_execution_environments",
            "执行环境",
          )}
        </h1>
        <p className="mt-1 text-sm text-text-muted">
          {translate(
            isWorkspaceScope
              ? "todo.workspace_execution_environments_description"
              : "todo.project_execution_environments_description",
            isWorkspaceScope
              ? "管理空间级环境配置，并在在线设备上创建可供项目复用的执行环境。"
              : "管理项目环境配置，并在在线设备上创建实际的执行环境。",
          )}
        </p>

        <section className="mt-6 overflow-hidden rounded-xl border border-border">
          <div className="px-5 py-5">
            <h2 className="text-sm font-medium">
              {translate(
                "todo.execution_environment_configuration",
                "环境配置",
              )}
            </h2>
            <p className="mt-1 text-sm text-text-muted">
              {translate(
                "todo.execution_environment_configuration_description",
                "定义创建执行环境时使用的代码来源和初始化命令。",
              )}
            </p>

            <div className="mt-5">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-medium">
                  {translate(
                    "todo.execution_environment_repositories",
                    "代码仓库",
                  )}
                </h3>
                {canManage ? (
                  <button
                    className="collaboration-link-button"
                    data-testid={`${testIdPrefix}-add-repository`}
                    disabled={saving}
                    type="button"
                    onClick={addRepository}
                  >
                    ＋ {translate("todo.add_repository", "添加仓库")}
                  </button>
                ) : null}
              </div>
              <p className="mt-1 text-xs text-text-muted">
                {translate(
                  "todo.execution_environment_repositories_description",
                  "主仓库是智能体默认工作目录；其他仓库会克隆到同一环境下的独立目录。",
                )}
              </p>

              <div className="mt-3 space-y-3">
                {repositories.map((repository, index) => (
                  <div
                    className="rounded-lg border border-border p-4"
                    data-testid={`${testIdPrefix}-repository-${index}`}
                    key={repository.id}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <label className="flex items-center gap-2 text-sm font-medium">
                        <input
                          checked={repository.primary}
                          disabled={!canManage || saving}
                          name={`${testIdPrefix}-primary-repository`}
                          type="radio"
                          onChange={() =>
                            updateRepository(repository.id, { primary: true })
                          }
                        />
                        {repository.primary
                          ? translate(
                              "todo.execution_environment_primary_repository",
                              "主仓库",
                            )
                          : translate(
                              "todo.execution_environment_dependency_repository",
                              "依赖仓库",
                            )}
                      </label>
                      {canManage && repositories.length > 1 ? (
                        <button
                          className="text-sm text-text-secondary hover:text-text-primary"
                          data-testid={`${testIdPrefix}-remove-repository-${index}`}
                          disabled={saving}
                          type="button"
                          onClick={() => removeRepository(repository.id)}
                        >
                          {translate("common.remove", "移除")}
                        </button>
                      ) : null}
                    </div>
                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                      <label className="text-sm">
                        <span className="mb-1 block">
                          {translate("todo.repository_name", "名称")}
                        </span>
                        <input
                          className="h-9 w-full rounded-lg border border-border bg-background px-3"
                          data-testid={`${testIdPrefix}-repository-name-${index}`}
                          disabled={!canManage || saving}
                          placeholder="Wegent"
                          value={repository.name}
                          onChange={(event) =>
                            updateRepository(repository.id, {
                              name: event.target.value,
                            })
                          }
                        />
                      </label>
                      <label className="text-sm">
                        <span className="mb-1 block">
                          {translate("todo.repository_path", "目录")}
                        </span>
                        <input
                          className="h-9 w-full rounded-lg border border-border bg-background px-3"
                          data-testid={`${testIdPrefix}-repository-path-${index}`}
                          disabled={!canManage || saving}
                          placeholder={
                            repository.primary ? "wegent" : "deps/internal-sdk"
                          }
                          value={repository.path}
                          onChange={(event) =>
                            updateRepository(repository.id, {
                              path: event.target.value,
                            })
                          }
                        />
                      </label>
                    </div>
                    <div className="mt-3 grid gap-3 md:grid-cols-[minmax(0,1fr)_180px]">
                      <label className="text-sm">
                        <span className="mb-1 block">
                          {translate("todo.repository_url", "Git 仓库")}
                        </span>
                        <input
                          className="h-9 w-full rounded-lg border border-border bg-background px-3"
                          data-testid={`${testIdPrefix}-repository-url-${index}`}
                          disabled={!canManage || saving}
                          placeholder="https://github.com/org/repository.git"
                          value={repository.url}
                          onChange={(event) =>
                            updateRepository(repository.id, {
                              url: event.target.value,
                            })
                          }
                        />
                      </label>
                      <label className="text-sm">
                        <span className="mb-1 block">
                          {translate(
                            "todo.execution_environment_repository_ref",
                            "分支或 Tag",
                          )}
                        </span>
                        <input
                          className="h-9 w-full rounded-lg border border-border bg-background px-3"
                          data-testid={`${testIdPrefix}-repository-ref-${index}`}
                          disabled={!canManage || saving}
                          placeholder="main"
                          value={repository.ref}
                          onChange={(event) =>
                            updateRepository(repository.id, {
                              ref: event.target.value,
                            })
                          }
                        />
                      </label>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-5">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-medium">
                  {translate("todo.execution_environment_setup", "初始化步骤")}
                </h3>
                {canManage ? (
                  <button
                    className="collaboration-link-button"
                    data-testid={`${testIdPrefix}-add-setup-step`}
                    disabled={saving}
                    type="button"
                    onClick={() => {
                      setSetupSteps((current) => [
                        ...current,
                        {
                          id: draftId("setup"),
                          command: "",
                          working_directory: "",
                        },
                      ]);
                      setConfigSaved(false);
                    }}
                  >
                    ＋ {translate("todo.add_setup_step", "添加步骤")}
                  </button>
                ) : null}
              </div>
              <p className="mt-1 text-xs text-text-muted">
                {translate(
                  "todo.execution_environment_setup_description",
                  "步骤按顺序执行；工作目录为空时在主仓库执行，也可以指定任一仓库目录。",
                )}
              </p>
              <div className="mt-3 space-y-2">
                {setupSteps.map((step, index) => (
                  <div
                    className="grid gap-2 md:grid-cols-[minmax(0,1fr)_220px_auto]"
                    data-testid={`${testIdPrefix}-setup-step-${index}`}
                    key={step.id}
                  >
                    <input
                      className="h-9 rounded-lg border border-border bg-background px-3 font-mono text-sm"
                      data-testid={`${testIdPrefix}-setup-command-${index}`}
                      disabled={!canManage || saving}
                      placeholder="pnpm install"
                      value={step.command}
                      onChange={(event) =>
                        updateSetupStep(step.id, {
                          command: event.target.value,
                        })
                      }
                    />
                    <input
                      className="h-9 rounded-lg border border-border bg-background px-3 font-mono text-sm"
                      data-testid={`${testIdPrefix}-setup-directory-${index}`}
                      disabled={!canManage || saving}
                      placeholder="工作目录（默认主仓库）"
                      value={step.working_directory}
                      onChange={(event) =>
                        updateSetupStep(step.id, {
                          working_directory: event.target.value,
                        })
                      }
                    />
                    {canManage ? (
                      <button
                        className="px-2 text-sm text-text-secondary hover:text-text-primary"
                        disabled={saving}
                        type="button"
                        onClick={() => {
                          setSetupSteps((current) =>
                            current.filter(
                              (candidate) => candidate.id !== step.id,
                            ),
                          );
                          setConfigSaved(false);
                        }}
                      >
                        {translate("common.remove", "移除")}
                      </button>
                    ) : null}
                  </div>
                ))}
                {setupSteps.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-border px-4 py-3 text-xs text-text-muted">
                    {translate(
                      "todo.no_setup_steps",
                      "没有初始化步骤，仓库克隆完成后即可使用。",
                    )}
                  </p>
                ) : null}
              </div>
            </div>
          </div>

          <div className="border-t border-border px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-medium">
                  {translate(
                    isWorkspaceScope
                      ? "todo.configured_workspace_execution_environments"
                      : "todo.configured_project_execution_environments",
                    "运行设备",
                  )}
                </h2>
                <span className="rounded-md bg-muted px-2 py-0.5 text-xs text-text-muted">
                  {assignedItems.length}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {assignedItems.length > 1 ? (
                  <label className="flex items-center gap-2 text-xs text-text-secondary">
                    {translate(
                      "todo.execution_environment_status_filter",
                      "状态",
                    )}
                    <select
                      className="h-8 rounded-lg border border-border bg-background px-2 text-sm text-text-primary"
                      data-testid={`${testIdPrefix}-status-filter`}
                      value={statusFilter}
                      onChange={(event) =>
                        setStatusFilter(
                          event.target.value as typeof statusFilter,
                        )
                      }
                    >
                      <option value="all">
                        {translate(
                          "todo.execution_environment_all_statuses",
                          "全部",
                        )}
                      </option>
                      {executionEnvironmentStatuses.map((status) => (
                        <option key={status} value={status}>
                          {executionEnvironmentStatusLabel(status, translate)}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {canManage ? (
                  <button
                    type="button"
                    className="collaboration-secondary-button"
                    data-testid={`${testIdPrefix}-add`}
                    disabled={loading || saving}
                    onClick={() => setPickerOpen((current) => !current)}
                  >
                    {pickerOpen
                      ? translate("common.cancel", "取消")
                      : `＋ ${translate("todo.add_execution_device", "添加设备")}`}
                  </button>
                ) : null}
              </div>
            </div>
            <p className="mt-1 text-xs text-text-muted">
              {translate(
                isWorkspaceScope
                  ? "todo.workspace_execution_devices_description"
                  : "todo.project_execution_devices_description",
                isWorkspaceScope
                  ? "空间内项目可以使用这里的在线设备执行任务。"
                  : "初始化和后续任务会从这里的在线设备中选择。",
              )}
            </p>

            <div className="pt-3">
              {loading ? (
                <p className="text-sm text-text-muted">
                  {translate("common.loading", "加载中…")}
                </p>
              ) : error ? (
                <div
                  className="rounded-xl border border-red-200 bg-red-50 px-4 py-4 text-sm text-red-700"
                  data-testid={`${testIdPrefix}s-error`}
                  role="alert"
                >
                  {error}
                </div>
              ) : assignedItems.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border px-4 py-3">
                  <p className="text-sm font-medium">
                    {translate(
                      isWorkspaceScope
                        ? "todo.no_workspace_execution_environments"
                        : "todo.no_project_execution_environments",
                      "尚未添加运行设备",
                    )}
                  </p>
                  <p className="mt-0.5 text-xs text-text-muted">
                    {availableItems.length === 0
                      ? translate(
                          isWorkspaceScope
                            ? "todo.configure_workspace_environment"
                            : "todo.configure_project_environment",
                          "当前没有在线设备，请先在资源库添加或启动设备。",
                        )
                      : translate(
                          isWorkspaceScope
                            ? "todo.select_workspace_environment"
                            : "todo.select_project_environment",
                          "添加一台在线设备，用于完成环境初始化和运行任务。",
                        )}
                  </p>
                </div>
              ) : visibleAssignedItems.length === 0 ? (
                <p className="text-sm text-text-muted" role="status">
                  {translate(
                    "todo.execution_environment_no_matches",
                    "没有符合当前状态的执行环境",
                  )}
                </p>
              ) : (
                <div className="overflow-hidden rounded-lg border border-border">
                  {visibleAssignedItems.map((environment, index) => {
                    const hasEnvironment =
                      initializingDeviceId === environment.device_id ||
                      (preparedDeviceId !== "" &&
                        (preparedDeviceId === environment.device_key ||
                          preparedDeviceId === String(environment.device_id)));
                    const instanceStatus =
                      initializingDeviceId === environment.device_id
                        ? "preparing"
                        : hasEnvironment
                          ? environmentStatus
                          : "uninitialized";
                    return (
                      <div
                        className={`flex items-center gap-3 px-4 py-3 ${
                          index > 0 ? "border-t border-border" : ""
                        }`}
                        data-testid={`${testIdPrefix}-${environment.device_id}`}
                        key={environment.id}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">
                            {environment.name}
                          </span>
                          <span className="block text-xs text-text-muted">
                            {environment.kind === "cloud_host"
                              ? translate("todo.cloud_host", "云主机")
                              : translate("todo.local_device", "本地设备")}
                            {" · "}
                            {isWorkspaceScope ||
                            (environment.device_id != null &&
                              workspaceDeviceIds.has(environment.device_id))
                              ? translate("todo.workspace_shared", "空间共享")
                              : translate(
                                  "todo.project_direct",
                                  "项目直接添加",
                                )}
                            {" · "}
                            {executionEnvironmentStatusLabel(
                              environment.status,
                              translate,
                            )}
                          </span>
                        </span>
                        <span className="text-xs text-text-secondary">
                          {instanceStatus === "ready"
                            ? translate(
                                "todo.execution_environment_ready",
                                "环境已就绪",
                              )
                            : instanceStatus === "preparing"
                              ? translate(
                                  "todo.execution_environment_preparing",
                                  "正在创建环境",
                                )
                              : instanceStatus === "error"
                                ? translate(
                                    "todo.execution_environment_initialization_error",
                                    "环境创建失败",
                                  )
                                : translate(
                                    "todo.execution_environment_uninitialized",
                                    "尚未创建环境",
                                  )}
                        </span>
                        {canManage && environment.status === "online" ? (
                          <button
                            type="button"
                            className="collaboration-link-button"
                            data-testid={`${testIdPrefix}-initialize-${environment.device_id}`}
                            disabled={saving}
                            onClick={() =>
                              void createEnvironmentOnDevice(environment)
                            }
                          >
                            {hasEnvironment
                              ? translate(
                                  "todo.execution_environment_reinitialize",
                                  "重新创建",
                                )
                              : translate(
                                  "todo.execution_environment_create",
                                  "创建环境",
                                )}
                          </button>
                        ) : null}
                        {canManage ? (
                          <button
                            type="button"
                            className="text-sm text-text-secondary hover:text-text-primary"
                            data-testid={`${testIdPrefix}-remove-${environment.device_id}`}
                            disabled={saving}
                            onClick={() => void removeEnvironment(environment)}
                          >
                            {translate("common.remove", "移除")}
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {canManage ? (
              <div>
                {pickerOpen ? (
                  <div
                    className="mt-3 overflow-hidden rounded-lg border border-border"
                    data-testid={`${testIdPrefix}-picker`}
                  >
                    <div className="border-b border-border bg-muted px-4 py-3">
                      <h3 className="text-sm font-medium">
                        {translate(
                          "todo.select_execution_device",
                          "选择在线设备",
                        )}
                      </h3>
                      <p className="mt-0.5 text-xs text-text-muted">
                        {isWorkspaceScope
                          ? translate(
                              "todo.select_workspace_environment",
                              "从我的资源中选择设备，授权给这个空间共享使用。",
                            )
                          : translate(
                              "todo.select_project_environment",
                              "从我的资源或空间共享资源中选择设备，授权给这个项目使用。",
                            )}
                      </p>
                    </div>
                    {candidates.length === 0 ? (
                      <p
                        className="px-4 py-5 text-sm text-text-muted"
                        role="status"
                      >
                        {translate(
                          "todo.no_available_execution_environments",
                          "没有可添加的在线执行环境",
                        )}
                      </p>
                    ) : (
                      <div className="divide-y divide-border">
                        {candidates.map((environment) => (
                          <div
                            className="flex items-center gap-4 px-4 py-3"
                            key={environment.id}
                          >
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium">
                                {environment.name}
                              </span>
                              <span className="block text-xs text-text-muted">
                                {environment.kind === "cloud_host"
                                  ? translate("todo.cloud_host", "云主机")
                                  : translate("todo.local_device", "本地设备")}
                                {" · "}
                                {executionEnvironmentStatusLabel(
                                  environment.status,
                                  translate,
                                )}
                                {" · "}
                                {environment.device_id != null &&
                                workspaceDeviceIds.has(environment.device_id)
                                  ? translate(
                                      "todo.workspace_shared",
                                      "空间共享",
                                    )
                                  : translate(
                                      "todo.personal_resource",
                                      "我的资源",
                                    )}
                              </span>
                            </span>
                            <button
                              type="button"
                              className="collaboration-link-button"
                              data-testid={`${testIdPrefix}-candidate-${environment.device_id}`}
                              disabled={saving}
                              onClick={() => void addEnvironment(environment)}
                            >
                              ＋ {translate("common.add", "添加")}
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="border-t border-border bg-muted px-5 py-4">
            {environmentError ? (
              <p className="mb-3 text-sm text-red-600" role="alert">
                {environmentError}
              </p>
            ) : null}
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-text-muted">
                {translate(
                  "todo.execution_environment_create_hint",
                  "填写配置后，在一台在线设备上点击“创建环境”；创建过程会同时保存配置并完成初始化。",
                )}
              </p>
              {configSaved ? (
                <span className="shrink-0 text-sm text-green-600" role="status">
                  {translate("common.saved", "环境已创建")}
                </span>
              ) : null}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
