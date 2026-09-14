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
  CollaborationProject,
  CollaborationWorkspace,
} from "../types";

type ExecutionEnvironmentScope =
  | {
      project: Pick<
        CollaborationProject,
        "id" | "workspace_id" | "access_role"
      >;
      workspace?: never;
    }
  | {
      project?: never;
      workspace: Pick<CollaborationWorkspace, "id" | "access_role">;
    };

export function ProjectExecutionEnvironments({
  api,
  project,
  translate,
  onRegisterDevice,
  workspace,
}: {
  api: SharedWorkspaceApi;
  translate: CollaborationTranslate;
  onRegisterDevice?: () => void;
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
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [statusFilter, setStatusFilter] = useState<
    "all" | CollaborationExecutionEnvironment["status"]
  >("all");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
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
      !selectedDeviceIds.has(environment.device_id),
  );
  const matchesStatus = (environment: CollaborationExecutionEnvironment) =>
    statusFilter === "all" || environment.status === statusFilter;
  const visibleCandidates = candidates.filter(matchesStatus);
  const visibleAssignedItems = assignedItems.filter(matchesStatus);
  const selectedCandidate = visibleCandidates.find(
    (environment) => String(environment.device_id) === selectedDeviceId,
  );

  async function addEnvironment() {
    const deviceId = selectedCandidate?.device_id;
    if (deviceId == null || saving) return;
    setSaving(true);
    setError("");
    try {
      const created = isWorkspaceScope
        ? await api.workspaces!.addExecutionEnvironment(scopeId, { deviceId })
        : await api.projects.addExecutionEnvironment(scopeId, deviceId);
      setAssignedItems((current) => [...current, created]);
      setSelectedDeviceId("");
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : translate(
              "todo.execution_environment_add_failed",
              "添加执行环境失败",
            ),
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

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-8 py-7">
      <div className="mx-auto max-w-[840px]">
        <div className="flex items-start justify-between gap-4">
          <div>
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
                  ? "管理空间共享设备池；空间内项目可以复用这些设备，也可以直接添加自己的设备。"
                  : "管理项目可使用的设备池；自动处理和人工分配会在运行时从池中选择设备。",
              )}
            </p>
          </div>
          {canManage && onRegisterDevice ? (
            <button
              type="button"
              className="collaboration-secondary-button shrink-0"
              data-testid={`${testIdPrefix}-register`}
              onClick={onRegisterDevice}
            >
              {translate("todo.register_device", "注册设备")}
            </button>
          ) : null}
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-border pt-5">
          <label className="flex items-center gap-2 text-sm">
            {translate("todo.execution_environment_status_filter", "设备状态")}
            <select
              className="h-9 rounded-lg border border-border bg-background px-3 text-sm"
              data-testid={`${testIdPrefix}-status-filter`}
              value={statusFilter}
              onChange={(event) => {
                setStatusFilter(event.target.value as typeof statusFilter);
                setSelectedDeviceId("");
              }}
            >
              <option value="all">
                {translate(
                  "todo.execution_environment_all_statuses",
                  "全部状态",
                )}
              </option>
              {executionEnvironmentStatuses.map((status) => (
                <option key={status} value={status}>
                  {executionEnvironmentStatusLabel(status, translate)}
                </option>
              ))}
            </select>
          </label>
        </div>

        {canManage && candidates.length > 0 ? (
          <div className="mt-3 flex gap-2">
            <select
              className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-sm"
              data-testid={`${testIdPrefix}-select`}
              aria-label={translate(
                "todo.select_workspace_execution_environment",
                "选择执行环境",
              )}
              disabled={visibleCandidates.length === 0 || saving}
              value={selectedCandidate ? selectedDeviceId : ""}
              onChange={(event) => setSelectedDeviceId(event.target.value)}
            >
              <option value="">
                {visibleCandidates.length === 0
                  ? translate(
                      "todo.execution_environment_no_matches",
                      "没有符合当前状态的执行环境",
                    )
                  : translate(
                      "todo.select_workspace_execution_environment",
                      "选择执行环境",
                    )}
              </option>
              {visibleCandidates.map((environment) => (
                <option key={environment.id} value={environment.device_id}>
                  {environment.name}
                  {` · ${executionEnvironmentStatusLabel(environment.status, translate)}`}
                  {environment.device_id != null &&
                  workspaceDeviceIds.has(environment.device_id)
                    ? ` · ${translate("todo.workspace_shared", "空间共享")}`
                    : ` · ${translate("todo.personal_resource", "我的资源")}`}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="collaboration-primary-button"
              data-testid={`${testIdPrefix}-add`}
              disabled={!selectedCandidate || saving}
              onClick={() => void addEnvironment()}
            >
              {translate("common.add", "添加")}
            </button>
          </div>
        ) : null}

        <div className="pt-5">
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
            <div className="rounded-xl bg-muted px-4 py-5">
              <p className="text-sm font-medium">
                {translate(
                  isWorkspaceScope
                    ? "todo.no_workspace_execution_environments"
                    : "todo.no_project_execution_environments",
                  isWorkspaceScope ? "空间设备池为空" : "项目设备池为空",
                )}
              </p>
              <p className="mt-1 text-sm text-text-muted">
                {availableItems.length === 0
                  ? translate(
                      isWorkspaceScope
                        ? "todo.configure_workspace_environment"
                        : "todo.configure_project_environment",
                      "当前没有执行环境。请先在资源库添加本地设备或云主机。",
                    )
                  : translate(
                      isWorkspaceScope
                        ? "todo.select_workspace_environment"
                        : "todo.select_project_environment",
                      isWorkspaceScope
                        ? "从我的资源中选择设备，授权给这个空间共享使用。"
                        : "从我的资源或空间共享资源中选择设备，授权给这个项目使用。",
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
            <div className="space-y-2">
              {visibleAssignedItems.map((environment) => (
                <div
                  className="flex items-center rounded-xl border border-border px-4 py-3"
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
                        : translate("todo.project_direct", "项目直接添加")}
                    </span>
                  </span>
                  <span className="mr-3 text-xs text-text-secondary">
                    {executionEnvironmentStatusLabel(
                      environment.status,
                      translate,
                    )}
                  </span>
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
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
