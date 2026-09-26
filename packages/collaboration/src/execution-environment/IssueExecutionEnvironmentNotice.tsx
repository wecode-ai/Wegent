// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { CircleAlert } from "lucide-react";

import type { CollaborationTranslate } from "../i18n";
import type { ProjectExecutionEnvironmentReadiness } from "./issueEnvironmentReadiness";

export function IssueExecutionEnvironmentNotice({
  canManage,
  onOpenEnvironmentSettings,
  readiness,
  translate,
}: {
  canManage: boolean;
  onOpenEnvironmentSettings(): void;
  readiness: ProjectExecutionEnvironmentReadiness & { refresh(): void };
  translate: CollaborationTranslate;
}) {
  if (
    readiness.kind === "not_applicable" ||
    readiness.kind === "loading" ||
    readiness.kind === "ready"
  ) {
    return null;
  }

  const description =
    readiness.kind === "unassigned"
      ? translate(
          "todo.issue_environment_notice_unassigned",
          "当前项目还没有可用的执行环境。请先完成环境初始化，再创建 Issue。",
        )
      : readiness.kind === "offline"
        ? translate(
            "todo.issue_environment_notice_offline",
            "项目环境已配置，但运行设备当前离线。请先启动设备，再创建 Issue。",
          )
        : readiness.kind === "preparing"
          ? translate(
              "todo.issue_environment_notice_preparing",
              "项目环境正在初始化。请等待环境就绪后再创建 Issue。",
            )
          : readiness.kind === "error"
            ? translate(
                "todo.issue_environment_notice_error",
                "项目环境初始化失败。请修复并重新初始化环境后再创建 Issue。",
              )
            : readiness.kind === "unknown"
              ? translate(
                  "todo.issue_environment_notice_unknown",
                  "暂时无法检查项目执行环境。请重新检查后再创建 Issue。",
                )
              : translate(
                  "todo.issue_environment_notice_uninitialized",
                  "项目运行设备尚未完成环境初始化。请先初始化环境，再创建 Issue。",
                );
  const actionLabel =
    readiness.kind === "unknown"
      ? translate("todo.issue_environment_notice_retry", "重新检查")
      : canManage
        ? translate("todo.issue_environment_notice_configure", "去配置执行环境")
        : translate("todo.issue_environment_notice_view", "查看执行环境");

  return (
    <div
      className="flex items-start gap-3 rounded-xl border border-border bg-muted/60 px-4 py-3 text-sm text-text-secondary"
      data-testid="issue-execution-environment-notice"
      role="status"
    >
      <CircleAlert
        aria-hidden="true"
        className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400"
      />
      <p className="min-w-0 flex-1 leading-5">
        {description}
        {!canManage && readiness.kind !== "unknown" ? (
          <span className="ml-1">
            {translate(
              "todo.issue_environment_notice_contact_manager",
              "如需初始化，请联系项目 Owner 或 Maintainer。",
            )}
          </span>
        ) : null}
      </p>
      <button
        type="button"
        className="min-h-7 shrink-0 rounded-md px-2 text-sm font-medium text-text-primary hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        data-testid="issue-execution-environment-notice-action"
        onClick={
          readiness.kind === "unknown"
            ? readiness.refresh
            : onOpenEnvironmentSettings
        }
      >
        {actionLabel}
      </button>
    </div>
  );
}
