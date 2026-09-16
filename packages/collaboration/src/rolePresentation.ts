// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { CollaborationRole } from "./types";

type CollaborationLocale = "zh-CN" | "en";

const presentation = {
  "zh-CN": {
    workspace: {
      Owner: ["空间所有者", "管理空间、成员和共享资源，并可移交所有权。"],
      Maintainer: ["空间管理员", "管理空间成员和共享资源，但不能移交所有权。"],
      Developer: ["空间协作者", "使用空间资源并创建项目，不管理空间成员。"],
      Reporter: ["空间观察者", "查看空间及其可见资源，不进行修改。"],
    },
  },
  en: {
    workspace: {
      Owner: [
        "Workspace owner",
        "Manages the workspace, members, shared resources, and ownership.",
      ],
      Maintainer: [
        "Workspace admin",
        "Manages workspace members and shared resources, but not ownership.",
      ],
      Developer: [
        "Workspace collaborator",
        "Uses workspace resources and creates projects without managing members.",
      ],
      Reporter: [
        "Workspace observer",
        "Views the workspace and visible resources without modifying them.",
      ],
    },
  },
} as const;

export function collaborationRoleLabel(
  locale: CollaborationLocale,
  role: CollaborationRole,
): string {
  return presentation[locale].workspace[role][0];
}

export function collaborationRoleDescription(
  locale: CollaborationLocale,
  role: CollaborationRole,
): string {
  return presentation[locale].workspace[role][1];
}
