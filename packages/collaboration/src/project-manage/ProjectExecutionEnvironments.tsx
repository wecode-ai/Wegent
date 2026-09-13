// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "react";

import type { SharedWorkspaceApi } from "../ports/SharedWorkspaceApi";
import type {
  CollaborationExecutionEnvironment,
  CollaborationProject,
} from "../types";
import type { CollaborationTranslate } from "../i18n";

export function ProjectExecutionEnvironments({
  api,
  project,
  translate,
}: {
  api: SharedWorkspaceApi;
  project: CollaborationProject;
  translate: CollaborationTranslate;
}) {
  const [items, setItems] = useState<CollaborationExecutionEnvironment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setItems([]);
    setError("");
    if (!project.workspace_id || !api.workspaces) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void api.workspaces
      .listExecutionEnvironments(project.workspace_id)
      .then((environments) => {
        if (active) setItems(environments);
      })
      .catch((loadError) => {
        if (!active) return;
        setError(
          loadError instanceof Error
            ? loadError.message
            : translate(
                "todo.execution_environments_load_failed",
                "加载执行环境失败",
              ),
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, project.workspace_id, translate]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-8 py-7">
      <div className="mx-auto max-w-[840px]">
        <h1 className="text-heading-lg font-semibold">
          {translate("todo.project_execution_environments", "可用执行环境")}
        </h1>
        <p className="mt-1 text-sm text-text-muted">
          {translate(
            "todo.project_execution_environments_description",
            "智能体执行任务时，从当前空间已授权的运行位置中选择。",
          )}
        </p>
        <div className="mt-6 border-t border-border pt-5">
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
          ) : items.length === 0 ? (
            <div className="rounded-xl bg-muted px-4 py-5">
              <p className="text-sm font-medium">
                {translate(
                  "todo.no_execution_environments",
                  "还没有可用执行环境",
                )}
              </p>
              <p className="mt-1 text-sm text-text-muted">
                {translate(
                  "todo.configure_workspace_environment",
                  "请先在当前空间的“执行环境”页面添加本地设备或云主机。",
                )}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {items.map((environment) => (
                <div
                  className="flex items-center rounded-xl border border-border px-4 py-3"
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
                    </span>
                  </span>
                  <span className="text-xs text-text-secondary">
                    {environment.status === "online"
                      ? translate("common.online", "在线")
                      : translate("common.offline", "离线")}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
