// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { CollaborationTranslate } from "../i18n";
import { ProjectSettingsPage } from "./ProjectSettingsPage";

export function ProjectHumanProcessing({
  translate,
}: {
  translate: CollaborationTranslate;
}) {
  const stages = [
    ["todo.human_work_pending", "待处理"],
    ["todo.human_work_in_progress", "处理中"],
    ["todo.human_work_waiting_review", "待确认"],
    ["todo.human_work_accepted", "已完成"],
  ] as const;

  return (
    <ProjectSettingsPage
      testId="collaboration-project-human-processing"
      title={translate("todo.human_processing_settings", "人工处理 · AI 辅助")}
      description={translate(
        "todo.human_processing_settings_description",
        "人工任务直接在 Issue 中处理。项目无需额外配置，AI 辅助由处理人按需启动。",
      )}
    >
      <section aria-label={translate("todo.human_work_flow", "处理流程")}>
        <h2 className="text-sm font-medium text-text-primary">
          {translate("todo.human_work_flow", "处理流程")}
        </h2>
        <ol className="mt-3 grid gap-2 sm:grid-cols-4">
          {stages.map(([key, fallback], index) => (
            <li key={key} className="flex items-center gap-2 text-sm">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs text-text-secondary">
                {index + 1}
              </span>
              <span className="text-text-primary">
                {translate(key, fallback)}
              </span>
            </li>
          ))}
        </ol>
        <p className="mt-3 text-sm text-text-secondary">
          {translate(
            "todo.human_work_return_flow",
            "验收人退回时只填写原因，任务回到处理中；原处理结果保留，可修改后再次提交。",
          )}
        </p>
      </section>

      <div className="mt-7 space-y-4 border-t border-border pt-5 text-sm">
        <div>
          <h2 className="font-medium text-text-primary">
            {translate("todo.human_work_reviewer", "谁来验收")}
          </h2>
          <p className="mt-1 text-text-secondary">
            {translate(
              "todo.human_work_reviewer_hint",
              "默认由指派人验收；若指派给自己，则由项目负责人或管理员验收。",
            )}
          </p>
        </div>
        <div>
          <h2 className="font-medium text-text-primary">
            {translate("todo.human_work_ai_assist", "AI 辅助")}
          </h2>
          <p className="mt-1 text-text-secondary">
            {translate(
              "todo.human_work_ai_assist_hint",
              "处理人可在任务中按需启动 AI，沿用项目执行环境；AI 不会代替处理人提交或验收。",
            )}
          </p>
        </div>
      </div>
    </ProjectSettingsPage>
  );
}
