// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { Bot } from "lucide-react";

import type { CollaborationTranslate } from "../i18n";

export function ProjectDispatchSettings({
  automationContent,
  runtimeContent,
  canManage,
  managerName,
  onConfigureAgents,
  onContinueManualAssignment,
  translate,
}: {
  automationContent?: ReactNode;
  runtimeContent?: ReactNode;
  canManage: boolean;
  managerName: string;
  onConfigureAgents(): void;
  onContinueManualAssignment(): void;
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
            <strong className="block text-sm font-medium">{managerName}</strong>
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
              "手动分配、成员主动参与和项目调度会分别记录来源与实际执行者。",
            )}
          </p>
        </section>
        {runtimeContent}
        {automationContent ? (
          <section
            className="mt-6 border-t border-border pt-5"
            data-testid="collaboration-project-dispatch-policy"
          >
            {automationContent}
          </section>
        ) : (
          <section
            className="mt-6 border-t border-border pt-5"
            data-testid="collaboration-project-dispatch-unavailable"
          >
            <div className="automation-policy">
              <header className="automation-policy-page-header">
                <div>
                  <h2>{translate("todo.dispatch_policy", "项目调度原则")}</h2>
                  <p>
                    {translate(
                      "todo.assignment_and_dispatch_description",
                      "明确谁负责项目，并约定 Issue 如何分配给成员或智能体。",
                    )}
                  </p>
                </div>
              </header>
              <main className="automation-policy-main">
                <div className="automation-policy-welcome">
                  <div className="automation-policy-welcome-icon">
                    <Bot size={30} />
                  </div>
                  <h2>
                    {translate(
                      "automation.policy.welcomeTitle",
                      "让项目按同一套原则持续运转",
                    )}
                  </h2>
                  <p>
                    {translate(
                      canManage
                        ? "todo.dispatch_policy_unavailable_manager"
                        : "todo.dispatch_policy_unavailable_member",
                      canManage
                        ? "当前空间未启用 AI 项目管家。先配置本项目智能体，再返回这里设置调度原则。"
                        : "当前空间未启用 AI 项目管家。请联系项目管理员配置；你仍可手动分配 Issue 或主动开始处理。",
                    )}
                  </p>
                  <div className="automation-policy-header-actions">
                    {canManage ? (
                      <button
                        type="button"
                        className="automation-policy-primary-button"
                        data-testid="collaboration-dispatch-configure-agents"
                        onClick={onConfigureAgents}
                      >
                        {translate(
                          "todo.configure_project_agents",
                          "配置项目智能体",
                        )}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="automation-policy-secondary-button"
                      data-testid="collaboration-dispatch-continue-manual"
                      onClick={onContinueManualAssignment}
                    >
                      {translate(
                        "todo.continue_manual_assignment",
                        "继续使用手动分配",
                      )}
                    </button>
                  </div>
                </div>
              </main>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
