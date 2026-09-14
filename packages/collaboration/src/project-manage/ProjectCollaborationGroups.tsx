// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from "react";

import type { SharedWorkspaceApi } from "../ports/SharedWorkspaceApi";
import type { WorkspaceAutomationRun } from "../ports/SharedWorkspaceApi";
import type {
  CollaborationAgent,
  CollaborationGroup,
  CollaborationMember,
} from "../types";
import { WorkspaceCollaborationGroupsConfiguration } from "../platform/WorkspaceResourceConfiguration";

export function ProjectCollaborationGroups({
  api,
  projectId,
  workspaceId,
  members,
  agents,
  locale,
  canManage,
}: {
  api: SharedWorkspaceApi;
  projectId: string;
  workspaceId: string;
  members: CollaborationMember[];
  agents: CollaborationAgent[];
  locale: "zh-CN" | "en";
  canManage: boolean;
}) {
  const [groups, setGroups] = useState<CollaborationGroup[]>([]);
  const [workspaceGroups, setWorkspaceGroups] = useState<CollaborationGroup[]>(
    [],
  );
  const [runs, setRuns] = useState<
    Array<WorkspaceAutomationRun & { groupId: string; groupName: string }>
  >([]);
  const [pendingRunActionId, setPendingRunActionId] = useState<string | null>(
    null,
  );
  const [runActionError, setRunActionError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (
      !api.workspaces?.listCollaborationGroups ||
      !api.projects.listCollaborationGroups
    ) {
      return;
    }
    const [available, projectGroups] = await Promise.all([
      api.workspaces.listCollaborationGroups(workspaceId),
      api.projects.listCollaborationGroups(projectId),
    ]);
    setWorkspaceGroups(available);
    setGroups(projectGroups);
    if (api.projects.listCollaborationGroupRuns) {
      const groupRuns = await Promise.all(
        projectGroups.map(async (group) => {
          const rows = await api.projects.listCollaborationGroupRuns?.(
            projectId,
            group.id,
          );
          return (rows ?? []).map((run) => ({
            ...run,
            groupId: group.id,
            groupName: group.name,
          }));
        }),
      );
      setRuns(
        groupRuns
          .flat()
          .sort((left, right) =>
            String(right.createdAt ?? "").localeCompare(
              String(left.createdAt ?? ""),
            ),
          ),
      );
    } else {
      setRuns([]);
    }
  }, [api, projectId, workspaceId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const projectGroupIds = new Set(groups.map((group) => group.id));

  const applyRunAction = async (
    runId: string,
    action: () => Promise<unknown>,
  ) => {
    setPendingRunActionId(runId);
    setRunActionError(null);
    try {
      await action();
      await reload();
    } catch (error) {
      setRunActionError(
        error instanceof Error
          ? error.message
          : locale === "zh-CN"
            ? "运行操作失败"
            : "Run action failed",
      );
    } finally {
      setPendingRunActionId(null);
    }
  };

  const statusLabel = (status: string) => {
    const labels =
      locale === "zh-CN"
        ? {
            pending: "等待中",
            queued: "已排队",
            waiting_runtime: "等待运行环境",
            waiting_device: "等待设备",
            running: "运行中",
            succeeded: "已完成",
            failed: "失败",
            skipped: "已跳过",
            cancelled: "已取消",
          }
        : {
            pending: "Pending",
            queued: "Queued",
            waiting_runtime: "Waiting for runtime",
            waiting_device: "Waiting for device",
            running: "Running",
            succeeded: "Succeeded",
            failed: "Failed",
            skipped: "Skipped",
            cancelled: "Cancelled",
          };
    return labels[status as keyof typeof labels] ?? status;
  };

  return (
    <>
      <WorkspaceCollaborationGroupsConfiguration
        groups={groups}
        availableGroups={workspaceGroups.filter(
          (group) => !projectGroupIds.has(group.id),
        )}
        members={members}
        agents={agents}
        locale={locale}
        canManage={canManage}
        commands={{
          searchUsers: async () => [],
          addMember: async () => {
            throw new Error("Project collaboration groups cannot add members");
          },
          updateMember: async () => {
            throw new Error(
              "Project collaboration groups cannot update members",
            );
          },
          removeMember: async () => undefined,
          addAgent: async () => {
            throw new Error("Project collaboration groups cannot add agents");
          },
          removeAgent: async () => undefined,
          async createCollaborationGroup(input) {
            if (!api.projects.createCollaborationGroup) {
              throw new Error("Project collaboration group API is unavailable");
            }
            const created = await api.projects.createCollaborationGroup(
              projectId,
              input,
            );
            await reload();
            return created;
          },
          async addCollaborationGroup(groupId) {
            if (!api.projects.addCollaborationGroup) {
              throw new Error("Project collaboration group API is unavailable");
            }
            const added = await api.projects.addCollaborationGroup(
              projectId,
              groupId,
            );
            await reload();
            return added;
          },
          async removeCollaborationGroup(groupId) {
            if (!api.projects.removeCollaborationGroup) {
              throw new Error("Project collaboration group API is unavailable");
            }
            await api.projects.removeCollaborationGroup(projectId, groupId);
            await reload();
          },
          async runCollaborationGroup(groupId) {
            if (!api.projects.runCollaborationGroup) {
              throw new Error(
                "Project collaboration group run API is unavailable",
              );
            }
            await api.projects.runCollaborationGroup(projectId, groupId);
            await reload();
          },
          addExecutionEnvironment: async () => {
            throw new Error(
              "Project collaboration groups cannot add execution environments",
            );
          },
          removeExecutionEnvironment: async () => undefined,
        }}
      />
      <section
        className="collaboration-platform-panel collaboration-run-center"
        data-testid="collaboration-group-run-center"
      >
        <div className="collaboration-resource-heading">
          <div>
            <h2>{locale === "zh-CN" ? "运行记录" : "Runs"}</h2>
            <p>
              {locale === "zh-CN"
                ? "统一查看协作组的执行状态、任务结果和失败原因。"
                : "Review execution status, task results, and failures for every group."}
            </p>
          </div>
        </div>
        {runs.length ? (
          <div className="collaboration-run-list">
            {runs.map((run) => {
              const status = String(run.status);
              const taskTitle = String(run.taskTitle ?? "");
              const displayTaskTitle = taskTitle.startsWith(
                `${run.groupName} ·`,
              )
                ? locale === "zh-CN"
                  ? "协作任务"
                  : "Collaboration task"
                : taskTitle;
              const error = String(run.error ?? "");
              const createdAt = String(run.createdAt ?? "");
              return (
                <article
                  key={run.id}
                  data-testid={`collaboration-group-run-record-${run.id}`}
                >
                  <span
                    className={`collaboration-run-status ${status}`}
                    data-testid={`collaboration-group-run-status-${run.id}`}
                  >
                    {statusLabel(status)}
                  </span>
                  <span className="collaboration-run-summary">
                    <strong>{run.groupName}</strong>
                    <small>
                      {displayTaskTitle
                        ? displayTaskTitle
                        : locale === "zh-CN"
                          ? "尚未生成任务"
                          : "No task yet"}
                      {createdAt
                        ? ` · ${new Date(createdAt).toLocaleString(locale)}`
                        : ""}
                    </small>
                    {error ? <em>{error}</em> : null}
                  </span>
                  <span className="collaboration-resource-actions">
                    {status === "failed" ? (
                      <button
                        type="button"
                        className="collaboration-link-button"
                        data-testid={`collaboration-group-run-retry-${run.id}`}
                        disabled={pendingRunActionId === run.id}
                        onClick={() => {
                          void applyRunAction(run.id, () =>
                            api.automations.retryRun(projectId, run.id),
                          );
                        }}
                      >
                        {locale === "zh-CN" ? "重试" : "Retry"}
                      </button>
                    ) : null}
                    {[
                      "pending",
                      "queued",
                      "waiting_runtime",
                      "waiting_device",
                      "running",
                    ].includes(status) ? (
                      <button
                        type="button"
                        className="collaboration-link-button"
                        data-testid={`collaboration-group-run-cancel-${run.id}`}
                        disabled={pendingRunActionId === run.id}
                        onClick={() => {
                          void applyRunAction(run.id, () =>
                            api.automations.cancelRun(projectId, run.id),
                          );
                        }}
                      >
                        {locale === "zh-CN" ? "取消" : "Cancel"}
                      </button>
                    ) : null}
                  </span>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="collaboration-resource-empty">
            {locale === "zh-CN"
              ? "还没有运行记录。手动运行协作组，或等待定时与事件触发。"
              : "No runs yet. Run a group manually or wait for a scheduled or event trigger."}
          </div>
        )}
        {runActionError ? (
          <p className="collaboration-alert" role="alert">
            {runActionError}
          </p>
        ) : null}
      </section>
    </>
  );
}
