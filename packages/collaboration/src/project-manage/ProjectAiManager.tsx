// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from "react";
import type {
  SharedWorkspaceApi,
  WorkspaceProjectManagerConfig,
  WorkspaceProjectManagerRun,
} from "../ports/SharedWorkspaceApi";
import type { CollaborationAgent, CollaborationProject } from "../types";

const copy = {
  "zh-CN": {
    title: "项目管理者",
    description: "配置项目管理者智能体及其职责。",
    enabled: "启用项目管理者",
    agent: "管理者智能体",
    instructions: "管理指令",
    save: "保存设置",
    saving: "保存中…",
    history: "运行记录",
    noRuns: "暂无运行记录",
    approve: "同意",
    reject: "拒绝",
    pending: "待确认",
    conflict: "同一事件不能同时触发项目 AI 与自动处理，请调整触发条件。",
  },
  en: {
    title: "Project manager",
    description:
      "Configure the project manager Agent and its responsibilities.",
    enabled: "Enable project manager",
    agent: "Manager Agent",
    instructions: "Instructions",
    save: "Save settings",
    saving: "Saving…",
    history: "Run history",
    noRuns: "No runs yet",
    approve: "Approve",
    reject: "Reject",
    pending: "Pending confirmation",
    conflict:
      "A single event cannot trigger both project AI and automatic processing. Adjust the triggers.",
  },
};

export function ProjectAiManager({
  api,
  project,
  agents,
  locale,
}: {
  api: SharedWorkspaceApi;
  project: CollaborationProject;
  agents: CollaborationAgent[];
  locale: "zh-CN" | "en";
}) {
  const manager = api.projectManager;
  const labels = copy[locale];
  const canManage =
    project.access_role === "Owner" || project.access_role === "Maintainer";
  const [config, setConfig] = useState<WorkspaceProjectManagerConfig | null>(
    null,
  );
  const [runs, setRuns] = useState<WorkspaceProjectManagerRun[]>([]);
  const [selectedRun, setSelectedRun] =
    useState<WorkspaceProjectManagerRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!manager) return;
    const nextRuns = await manager.listRuns(project.id);
    setRuns(nextRuns);
    if (selectedRun) {
      const detail = await manager.getRun(project.id, selectedRun.id);
      setSelectedRun(detail);
    }
  }, [manager, project.id, selectedRun?.id]);

  useEffect(() => {
    if (manager) {
      void manager
        .get(project.id)
        .then(setConfig)
        .catch((cause) => setError(String(cause)));
    }
  }, [manager, project.id]);

  useEffect(() => {
    void refresh().catch((cause) => setError(String(cause)));
    const timer = window.setInterval(() => {
      void refresh().catch((cause) => setError(String(cause)));
    }, 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const patch = (values: Partial<WorkspaceProjectManagerConfig>) => {
    setConfig((previous) => (previous ? { ...previous, ...values } : previous));
  };
  const execute = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await work();
      await refresh();
    } catch (cause) {
      const errorMessage = String(cause);
      setError(
        /\boverlap(?:s|ping)?\b/i.test(errorMessage)
          ? labels.conflict
          : errorMessage,
      );
    } finally {
      setBusy(false);
    }
  };

  if (!manager) return null;
  return (
    <section className="space-y-4" data-testid="project-ai-settings">
      <div>
        <h2 className="heading-sm">{labels.title}</h2>
        <p className="mt-1 text-sm text-text-secondary">{labels.description}</p>
      </div>
      {error && (
        <p
          role="alert"
          className="mb-4 rounded-lg border border-border px-3 py-2 text-text-primary"
          data-testid="project-ai-error"
        >
          {error}
        </p>
      )}
      {config && (
        <div className="space-y-5">
          <label className="flex items-center gap-3 text-text-primary">
            <input
              type="checkbox"
              data-testid="project-ai-enabled"
              data-enabled={config.enabled}
              checked={config.enabled}
              disabled={!canManage || busy}
              onChange={(event) => patch({ enabled: event.target.checked })}
            />
            {labels.enabled}
          </label>
          <label className="block space-y-2 text-text-primary">
            <span>{labels.agent}</span>
            <select
              data-testid="project-ai-agent"
              className="w-full rounded-lg border border-border bg-background px-3 py-2"
              value={config.agentId}
              disabled={!canManage || busy}
              onChange={(event) => patch({ agentId: event.target.value })}
            >
              <option value="">—</option>
              {agents
                .filter(
                  (agent) =>
                    agent.status !== "archived" &&
                    (project.project_store === "local" ||
                      agent.runtime === "wegent"),
                )
                .map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="block space-y-2 text-text-primary">
            <span>{labels.instructions}</span>
            <textarea
              data-testid="project-ai-instructions"
              className="min-h-28 w-full rounded-lg border border-border bg-background px-3 py-2"
              value={config.prompt}
              disabled={!canManage || busy}
              onChange={(event) => patch({ prompt: event.target.value })}
            />
          </label>
          {canManage && (
            <button
              type="button"
              data-testid="project-ai-save"
              disabled={busy}
              className="rounded-lg bg-text-primary px-4 py-2 text-background"
              onClick={() =>
                void execute(async () => {
                  const saved = await manager.save(project.id, {
                    version: config.version,
                    enabled: config.enabled,
                    agentId: config.agentId,
                    prompt: config.prompt,
                    triggers: config.triggers,
                  });
                  setConfig(saved);
                })
              }
            >
              {busy ? labels.saving : labels.save}
            </button>
          )}
        </div>
      )}
      <section className="mt-9 space-y-3 border-t border-border pt-6">
        <h2 className="heading-sm">{labels.history}</h2>
        {runs.length === 0 && (
          <p className="text-text-secondary">{labels.noRuns}</p>
        )}
        {runs.map((run) => (
          <button
            type="button"
            key={run.id}
            data-testid={`project-ai-run-${run.id}`}
            className="block w-full rounded-lg border border-border px-3 py-2 text-left"
            onClick={() =>
              void manager
                .getRun(project.id, run.id)
                .then(setSelectedRun)
                .catch((cause) => setError(String(cause)))
            }
          >
            {run.trigger} · {run.status} · {run.createdAt}
          </button>
        ))}
        {selectedRun && (
          <div
            data-testid="project-ai-run-detail"
            className="space-y-3 rounded-lg border border-border p-4"
          >
            <p>
              {selectedRun.status} · {selectedRun.error ?? ""}
            </p>
            {selectedRun.actions?.map((action) => (
              <div key={action.id} className="rounded border border-border p-3">
                <p>
                  {action.kind} · {action.itemId} · {action.status}
                </p>
                {action.status === "pending_confirmation" &&
                  (action.approverUserId != null
                    ? action.approverUserId === project.current_user_id
                    : canManage) && (
                    <div className="mt-2 flex gap-2">
                      <button
                        type="button"
                        data-testid={`project-ai-approve-${action.id}`}
                        disabled={busy}
                        onClick={() =>
                          void execute(() =>
                            manager.decide(
                              project.id,
                              selectedRun.id,
                              action.id,
                              true,
                              action.itemVersion ?? 0,
                            ),
                          )
                        }
                      >
                        {labels.approve}
                      </button>
                      <button
                        type="button"
                        data-testid={`project-ai-reject-${action.id}`}
                        disabled={busy}
                        onClick={() =>
                          void execute(() =>
                            manager.decide(
                              project.id,
                              selectedRun.id,
                              action.id,
                              false,
                              action.itemVersion ?? 0,
                            ),
                          )
                        }
                      >
                        {labels.reject}
                      </button>
                    </div>
                  )}
              </div>
            ))}
          </div>
        )}
      </section>
    </section>
  );
}
