// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { ConfirmationDialog } from "../controls/ConfirmationDialog";
import type { CollaborationProject } from "../types";

const copy = {
  "zh-CN": {
    title: "归档项目？",
    hint: "归档后，项目将从协作列表中移除。此操作不会删除本地代码目录。",
    cancel: "取消",
    confirm: "归档项目",
    pending: "正在归档…",
    failed: "归档失败，请重试。",
  },
  en: {
    title: "Archive project?",
    hint: "The project will be removed from the collaboration list. Local code directories will not be deleted.",
    cancel: "Cancel",
    confirm: "Archive project",
    pending: "Archiving…",
    failed: "Could not archive the project. Please try again.",
  },
};

export function ProjectArchiveDialog({
  project,
  locale,
  onArchive,
  onClose,
}: {
  project: CollaborationProject;
  locale: "zh-CN" | "en";
  onArchive(): Promise<void>;
  onClose(): void;
}) {
  return (
    <ConfirmationDialog
      title={copy[locale].title}
      subject={project.name}
      description={copy[locale].hint}
      labels={copy[locale]}
      testIdPrefix="collaboration-project-archive"
      onConfirm={onArchive}
      onClose={onClose}
    />
  );
}
