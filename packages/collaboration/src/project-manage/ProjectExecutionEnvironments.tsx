// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useMemo, useState } from "react";
import { Cloud, HardDrive, Laptop, MonitorUp, Plus, X } from "lucide-react";

import type { CollaborationTranslate } from "../i18n";
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
  project: CollaborationProject;
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
  const [loading, setLoading] = useState(true);
  const [pendingDeviceIds, setPendingDeviceIds] = useState<Set<number>>(
    () => new Set(),
  );
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
      if (environment.device_id != null && environment.status === "online") {
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

  function environmentSource(environment: CollaborationExecutionEnvironment) {
    return environment.device_id != null &&
      workspaceDeviceIds.has(environment.device_id)
      ? translate("todo.workspace_shared", "空间共享")
      : translate("todo.personal_resource", "我的资源");
  }

  function environmentKind(environment: CollaborationExecutionEnvironment) {
    return environment.kind === "cloud_host"
      ? translate("todo.cloud_host", "云主机")
      : translate("todo.local_device", "本地设备");
  }

  async function addEnvironment(
    environment: CollaborationExecutionEnvironment,
  ) {
    const deviceId = environment.device_id;
    if (deviceId == null || pendingDeviceIds.has(deviceId)) return;
    setPendingDeviceIds((current) => new Set(current).add(deviceId));
    setProjectItems((current) => [...current, environment]);
    setError("");
    try {
      const created = await api.projects.addExecutionEnvironment(
        project.id,
        deviceId,
      );
      setProjectItems((current) =>
        current.map((item) => (item.device_id === deviceId ? created : item)),
      );
    } catch (saveError) {
      setProjectItems((current) =>
        current.filter((item) => item.device_id !== deviceId),
      );
      setError(
        saveError instanceof Error
          ? saveError.message
          : translate(
              "todo.execution_environment_add_failed",
              "添加执行环境失败",
            ),
      );
    } finally {
      setPendingDeviceIds((current) => {
        const next = new Set(current);
        next.delete(deviceId);
        return next;
      });
    }
  }

  async function removeEnvironment(
    environment: CollaborationExecutionEnvironment,
  ) {
    const deviceId = environment.device_id;
    if (deviceId == null || pendingDeviceIds.has(deviceId)) return;
    const previousIndex = projectItems.findIndex(
      (item) => item.device_id === deviceId,
    );
    setPendingDeviceIds((current) => new Set(current).add(deviceId));
    setProjectItems((current) =>
      current.filter((item) => item.device_id !== deviceId),
    );
    setError("");
    try {
      await api.projects.removeExecutionEnvironment(project.id, deviceId);
    } catch (saveError) {
      setProjectItems((current) => {
        if (current.some((item) => item.device_id === deviceId)) return current;
        const next = [...current];
        next.splice(Math.max(previousIndex, 0), 0, environment);
        return next;
      });
      setError(
        saveError instanceof Error
          ? saveError.message
          : translate(
              "todo.execution_environment_remove_failed",
              "移除执行环境失败",
            ),
      );
    } finally {
      setPendingDeviceIds((current) => {
        const next = new Set(current);
        next.delete(deviceId);
        return next;
      });
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-8 py-7">
      <div className="mx-auto max-w-[840px]">
        <h1 className="text-heading-lg font-semibold">
          {translate("todo.project_execution_environments", "执行环境")}
        </h1>
        <p className="mt-1 text-sm text-text-muted">
          {translate(
            "todo.project_execution_environments_description",
            "直接管理这个项目使用的执行环境；空间共享的环境也可以在这里复用。",
          )}
        </p>

        <div className="mt-6 border-t border-border pt-5">
          <div className="mb-3 flex min-h-9 items-center justify-between gap-4">
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="text-sm font-medium">
                {translate(
                  "todo.project_available_execution_environments",
                  "项目资源池",
                )}
              </h2>
              {!loading ? (
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-text-muted">
                  {projectItems.length}
                </span>
              ) : null}
            </div>
            <p className="text-xs text-text-muted">
              {translate(
                "todo.project_execution_environment_pool_hint",
                "项目内的工作会从资源池中选择设备运行",
              )}
            </p>
          </div>
          {loading ? (
            <div
              className="space-y-2"
              aria-label={translate("common.loading", "加载中…")}
            >
              <div className="h-16 animate-pulse rounded-xl bg-muted" />
              <div className="h-16 animate-pulse rounded-xl bg-muted" />
            </div>
          ) : (
            <div>
              {error ? (
                <div
                  className="mb-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
                  data-testid="collaboration-project-execution-environments-error"
                  role="alert"
                >
                  {error}
                </div>
              ) : null}
              {projectItems.length === 0 ? (
                <div className="flex min-h-32 items-center justify-center rounded-xl border border-dashed border-border bg-muted/30 px-6 py-7 text-center">
                  <div>
                    <span className="mx-auto grid h-10 w-10 place-items-center rounded-xl bg-muted">
                      <HardDrive
                        className="h-5 w-5 text-text-secondary"
                        aria-hidden="true"
                      />
                    </span>
                    <p className="mt-3 text-sm font-medium">
                      {translate(
                        "todo.no_project_execution_environments",
                        "资源池还是空的",
                      )}
                    </p>
                    <p className="mt-1 text-sm text-text-muted">
                      {availableItems.length === 0
                        ? translate(
                            "todo.configure_project_environment",
                            "当前没有可用设备，请先在资源库添加本地设备或云主机。",
                          )
                        : translate(
                            "todo.select_project_environment",
                            "点击下方资源，即可加入这个项目。",
                          )}
                    </p>
                  </div>
                </div>
              ) : (
                <div
                  className="grid grid-cols-1 gap-2 sm:grid-cols-2"
                  data-testid="collaboration-project-execution-environment-pool"
                >
                  {projectItems.map((environment) => {
                    const deviceId = environment.device_id;
                    const pending =
                      deviceId != null && pendingDeviceIds.has(deviceId);
                    return (
                      <div
                        className="group flex min-h-16 items-center gap-3 rounded-xl border border-border bg-background px-3.5 py-3 transition-colors hover:bg-muted/40"
                        key={environment.id}
                      >
                        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-muted">
                          {environment.kind === "cloud_host" ? (
                            <Cloud
                              className="h-4 w-4 text-text-secondary"
                              aria-hidden="true"
                            />
                          ) : (
                            <Laptop
                              className="h-4 w-4 text-text-secondary"
                              aria-hidden="true"
                            />
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">
                            {environment.name}
                          </span>
                          <span className="mt-0.5 flex items-center gap-1.5 text-xs text-text-muted">
                            <span
                              className={`h-1.5 w-1.5 rounded-full ${
                                environment.status === "online"
                                  ? "bg-emerald-500"
                                  : "bg-text-muted"
                              }`}
                              aria-hidden="true"
                            />
                            <span>
                              {pending
                                ? translate("common.saving", "保存中…")
                                : environmentKind(environment)}
                            </span>
                            {!pending ? (
                              <>
                                <span aria-hidden="true">·</span>
                                <span>
                                  {environment.device_id != null &&
                                  workspaceDeviceIds.has(environment.device_id)
                                    ? translate(
                                        "todo.workspace_shared",
                                        "空间共享",
                                      )
                                    : translate(
                                        "todo.project_direct",
                                        "项目直接添加",
                                      )}
                                </span>
                              </>
                            ) : null}
                          </span>
                        </span>
                        {canManage ? (
                          <button
                            type="button"
                            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-text-muted opacity-0 transition-opacity hover:bg-muted hover:text-text-primary focus:opacity-100 group-hover:opacity-100 disabled:opacity-40"
                            data-testid={`collaboration-project-execution-environment-remove-${deviceId}`}
                            disabled={pending}
                            aria-label={translate(
                              "todo.remove_execution_environment",
                              "移出资源池",
                            )}
                            onClick={() => void removeEnvironment(environment)}
                          >
                            <X className="h-4 w-4" aria-hidden="true" />
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {!loading &&
        canManage &&
        (candidates.length > 0 || onRegisterDevice) ? (
          <div className="mt-7 border-t border-border pt-5">
            <div className="mb-3 flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-medium">
                    {translate(
                      "todo.available_execution_resources",
                      "可添加资源",
                    )}
                  </h2>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-text-muted">
                    {candidates.length}
                  </span>
                </div>
                <p className="mt-1 text-xs text-text-muted">
                  {translate(
                    "todo.available_execution_resources_hint",
                    "点击资源即可加入项目，支持连续添加多个设备。",
                  )}
                </p>
              </div>
              {onRegisterDevice ? (
                <button
                  type="button"
                  className="collaboration-secondary-button shrink-0"
                  data-testid="collaboration-project-execution-environment-register"
                  onClick={onRegisterDevice}
                >
                  <MonitorUp className="h-4 w-4" aria-hidden="true" />
                  {translate("todo.register_device", "注册设备")}
                </button>
              ) : null}
            </div>
            {candidates.length > 0 ? (
              <div
                className="grid grid-cols-1 gap-2 sm:grid-cols-2"
                data-testid="collaboration-project-execution-environment-candidates"
              >
                {candidates.map((environment) => {
                  const deviceId = environment.device_id;
                  const EnvironmentIcon =
                    environment.kind === "cloud_host" ? Cloud : Laptop;
                  return (
                    <button
                      key={environment.id}
                      type="button"
                      className="group flex min-h-16 items-center gap-3 rounded-xl border border-border bg-background px-3.5 py-3 text-left transition-colors hover:border-text-muted hover:bg-muted/40"
                      data-testid={`collaboration-project-execution-environment-option-${deviceId}`}
                      onClick={() => void addEnvironment(environment)}
                    >
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-muted">
                        <EnvironmentIcon
                          className="h-4 w-4 text-text-secondary"
                          aria-hidden="true"
                        />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {environment.name}
                        </span>
                        <span className="mt-0.5 block text-xs text-text-muted">
                          {environmentKind(environment)}
                          {" · "}
                          {environmentSource(environment)}
                        </span>
                      </span>
                      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-border text-text-muted transition-colors group-hover:border-text-primary group-hover:bg-text-primary group-hover:text-background">
                        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-border px-5 py-6 text-center text-sm text-text-muted">
                {translate(
                  "todo.no_available_execution_resources",
                  "暂无可添加资源，可以先注册一台新设备。",
                )}
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
