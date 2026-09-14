// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";

import type { CollaborationTranslate } from "../i18n";

export function ProjectDispatchSettings({
  collaborationGroupsContent,
  translate,
}: {
  collaborationGroupsContent?: ReactNode;
  translate: CollaborationTranslate;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-8 py-7">
      <div className="mx-auto max-w-[840px]">
        <h1 className="text-heading-lg font-semibold">
          {translate("todo.collaboration_groups", "协作组")}
        </h1>
        <p className="mt-1 text-sm text-text-muted">
          {translate(
            "todo.collaboration_groups_description",
            "组织人与智能体共同处理 Issue，并在同一个协作组中配置触发、协作和输出方式。",
          )}
        </p>
        {collaborationGroupsContent ? (
          <section
            className="mt-6"
            data-testid="collaboration-project-dispatch-policy"
          >
            {collaborationGroupsContent}
          </section>
        ) : (
          <section
            className="mt-6"
            data-testid="collaboration-project-dispatch-unavailable"
          >
            <div className="rounded-xl border border-border bg-surface-subtle px-5 py-4">
              <h2 className="text-heading-sm font-semibold">
                {translate(
                  "todo.collaboration_groups_unavailable",
                  "暂时无法管理协作组",
                )}
              </h2>
              <p className="mt-1 max-w-[620px] text-sm text-text-muted">
                {translate(
                  "todo.collaboration_groups_unavailable_description",
                  "协作组服务当前不可用。Issue 的手动负责人设置不受影响。",
                )}
              </p>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
