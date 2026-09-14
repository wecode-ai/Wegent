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
} from "../types";

export function ProjectExecutionEnvironments({
  api,
  project,
  translate,
  onRegisterDevice,
}: {
  api: SharedWorkspaceApi;
  project: Pick<CollaborationProject, "id" | "workspace_id" | "access_role">;
  translate: CollaborationTranslate;
  onRegisterDevice?: () => void;
}) {
  const [workspaceItems, setWorkspaceItems] = useState<
    CollaborationExecutionEnvironment[]
  >([]);
  const [personalItems, setPersonalItems] = useState<
    CollaborationExecutionEnvironment[]
  >([]);
  const [projectItems, setProjectItems] = useState<
    CollaborationExecutionEnvironment[]
  >([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [statusFilter, setStatusFilter] = useState<
    "all" | CollaborationExecutionEnvironment["status"]
  >("all");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const canManage =
    project.access_role === "Owner" || project.access_role === "Maintainer";

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [projectEnvironments, personalResources, workspaceEnvironments] =
        await Promise.all([
          api.projects.listExecutionEnvironments(project.id),
          api.resources?.list() ?? {
            agents: [],
            execution_environments: [],
          },
          project.workspace_id && api.workspaces
            ? api.workspaces.listExecutionEnvironments(project.workspace_id)
            : [],
        ]);
      setWorkspaceItems(workspaceEnvironments);
      setPersonalItems(personalResources.execution_environments);
      setProjectItems(projectEnvironments);
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
  }, [api, project.id, project.workspace_id, translate]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedDeviceIds = useMemo(
    () =>
      new Set(
        projectItems
          .map((environment) => environment.device_id)
          .filter((deviceId): deviceId is number => deviceId != null),
      ),
    [projectItems],
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
  const visibleProjectItems = projectItems.filter(matchesStatus);
  const selectedCandidate = visibleCandidates.find(
    (environment) => String(environment.device_id) === selectedDeviceId,
  );

  async function addEnvironment() {
    const deviceId = selectedCandidate?.device_id;
    if (deviceId == null || saving) return;
    setSaving(true);
    setError("");
    try {
      const created = await api.projects.addExecutionEnvironment(
        project.id,
        deviceId,
      );
      setProjectItems((current) => [...current, created]);
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
      await api.projects.removeExecutionEnvironment(
        project.id,
        environment.device_id,
      );
      setProjectItems((current) =>
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
              {translate("todo.project_execution_environments", "执行环境")}
            </h1>
            <p className="mt-1 text-sm text-text-muted">
              {translate(
                "todo.project_execution_environments_description",
                "管理项目可使用的设备池；自动处理和人工分配会在运行时从池中选择设备。",
              )}
            </p>
          </div>
          {canManage && onRegisterDevice ? (
            <button
              type="button"
              className="collaboration-secondary-button shrink-0"
              data-testid="collaboration-project-execution-environment-register"
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
              data-testid="collaboration-project-execution-environment-status-filter"
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
              data-testid="collaboration-project-execution-environment-select"
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
              data-testid="collaboration-project-execution-environment-add"
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
              data-testid="collaboration-project-execution-environments-error"
              role="alert"
            >
              {error}
            </div>
          ) : projectItems.length === 0 ? (
            <div className="rounded-xl bg-muted px-4 py-5">
              <p className="text-sm font-medium">
                {translate(
                  "todo.no_project_execution_environments",
                  "项目设备池为空",
                )}
              </p>
              <p className="mt-1 text-sm text-text-muted">
                {availableItems.length === 0
                  ? translate(
                      "todo.configure_project_environment",
                      "当前没有执行环境。请先在资源库添加本地设备或云主机。",
                    )
                  : translate(
                      "todo.select_project_environment",
                      "从我的资源或空间共享资源中选择设备，授权给这个项目使用。",
                    )}
              </p>
            </div>
          ) : visibleProjectItems.length === 0 ? (
            <p className="text-sm text-text-muted" role="status">
              {translate(
                "todo.execution_environment_no_matches",
                "没有符合当前状态的执行环境",
              )}
            </p>
          ) : (
            <div className="space-y-2">
              {visibleProjectItems.map((environment) => (
                <div
                  className="flex items-center rounded-xl border border-border px-4 py-3"
                  data-testid={`collaboration-project-execution-environment-${environment.device_id}`}
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
                      {environment.device_id != null &&
                      workspaceDeviceIds.has(environment.device_id)
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
                      data-testid={`collaboration-project-execution-environment-remove-${environment.device_id}`}
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
