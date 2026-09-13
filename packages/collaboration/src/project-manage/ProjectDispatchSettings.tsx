// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";

import type { CollaborationTranslate } from "../i18n";
import type { CollaborationProject } from "../types";

export function ProjectDispatchSettings({
  automationContent,
  project,
  translate,
}: {
  automationContent?: ReactNode;
  project: CollaborationProject;
  translate: CollaborationTranslate;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-8 py-7">
      <div className="mx-auto max-w-[840px]">
        <h1 className="text-heading-lg font-semibold">
          {translate("todo.assignment_and_dispatch", "分配与调度")}
        </h1>
        <p className="mt-1 text-sm text-text-muted">
          {translate(
            "todo.assignment_and_dispatch_description",
            "明确谁负责项目，并约定 Issue 如何分配给成员或智能体。",
          )}
        </p>
        <section className="mt-6 border-t border-border pt-5">
          <h2 className="text-heading-sm font-semibold">
            {translate("todo.project_manager", "项目管理者")}
          </h2>
          <div
            className="mt-3 rounded-xl bg-muted px-4 py-4"
            data-testid="collaboration-project-manager-summary"
          >
            <strong className="block text-sm font-medium">
              {project.current_user_name ??
                translate("todo.current_user", "我自己")}
            </strong>
            <span className="mt-1 block text-sm text-text-muted">
              {translate(
                "todo.project_manager_description",
                "项目创建者默认负责成员、Issue 分配和交付确认。",
              )}
            </span>
          </div>
        </section>
        <section className="mt-6 border-t border-border pt-5">
          <h2 className="text-heading-sm font-semibold">
            {translate("todo.assignment_source", "分配来源")}
          </h2>
          <p className="mt-2 text-sm text-text-muted">
            {translate(
              "todo.assignment_source_description",
              "手动分配、成员主动参与和项目调度会分别记录来源；流程标识只说明分配来自哪个流程，不改变执行任务。",
            )}
          </p>
        </section>
        {automationContent ? (
          <section
            className="mt-6 border-t border-border pt-5"
            data-testid="collaboration-project-dispatch-policy"
          >
            {automationContent}
          </section>
        ) : (
          <section className="mt-6 border-t border-border pt-5">
            <h2 className="text-heading-sm font-semibold">
              {translate("todo.dispatch_policy", "项目调度原则")}
            </h2>
            <p className="mt-2 text-sm text-text-muted">
              {translate(
                "todo.dispatch_policy_unavailable",
                "当前空间未启用 AI 项目管家。成员仍可在 Issue 中手动分配或主动开始处理。",
              )}
            </p>
          </section>
        )}
      </div>
    </div>
  );
}
