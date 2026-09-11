// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Check, Cloud, Copy, MoreHorizontal, Plus } from 'lucide-react'
import {
  ProjectSpaceSidebar,
  collaborationMessages,
  type CollaborationLocale,
  type CollaborationProject,
} from '@wegent/collaboration'

interface CollaborationProjectSectionProps {
  locale: CollaborationLocale
  onAdd(): void
  onSelect(projectId: string): void
  projects: CollaborationProject[]
  selectedProjectId: string | null
}

export function CollaborationProjectSection({
  locale,
  onAdd,
  onSelect,
  projects,
  selectedProjectId,
}: CollaborationProjectSectionProps) {
  const messages = collaborationMessages[locale]

  return (
    <ProjectSpaceSidebar
      sectionOnly
      account={null}
      addIcon={<Plus className="mx-auto h-3.5 w-3.5" />}
      addLabel={messages.create}
      checkIcon={<Check className="h-3.5 w-3.5" />}
      copyIcon={<Copy className="h-3.5 w-3.5" />}
      header={null}
      labels={{
        actions: locale === 'zh-CN' ? '项目操作' : 'Project actions',
        archive: messages.archiveProject,
        copied: locale === 'zh-CN' ? '已复制' : 'Copied',
        copyId: locale === 'zh-CN' ? '复制项目 ID' : 'Copy project ID',
        rename: locale === 'zh-CN' ? '重命名' : 'Rename',
      }}
      moreIcon={<MoreHorizontal className="h-3.5 w-3.5" />}
      navItems={[]}
      onAdd={onAdd}
      onSelectProject={onSelect}
      projects={projects.map(project => ({
        canManage: false,
        icon: <Cloud className="h-4 w-4 shrink-0 text-text-muted" />,
        id: project.id,
        key: project.id,
        name: project.name,
        selected: project.id === selectedProjectId,
        onArchive: () => undefined,
        onCopyId: () => navigator.clipboard.writeText(project.public_id || project.id),
        onRename: () => undefined,
      }))}
      sectionLabel={messages.projects}
    />
  )
}
