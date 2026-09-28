// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { CollaborationTranslate } from "../i18n";
import type { CollaborationExecutionEnvironment } from "../types";

export const executionEnvironmentStatuses = [
  "online",
  "offline",
  "provisioning",
  "error",
] as const satisfies readonly CollaborationExecutionEnvironment["status"][];

const statusLabels = {
  online: "在线",
  offline: "离线",
  provisioning: "准备中",
  error: "异常",
} satisfies Record<CollaborationExecutionEnvironment["status"], string>;

export function executionEnvironmentStatusLabel(
  status: CollaborationExecutionEnvironment["status"],
  translate: CollaborationTranslate,
): string {
  return translate(
    `todo.execution_environment_${status}`,
    statusLabels[status],
  );
}
