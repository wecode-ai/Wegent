import type { RuntimeTaskAddress } from '@/types/api'
import { useState } from 'react'

import type { ArchiveRuntimeTaskOptions } from '@/features/workbench/workbenchContextTypes'

import type { DesktopSidebarProps } from './desktopSidebarTypes'

export function useDesktopSidebarSectionArchives({
  onArchiveProjectsConversations,
  onArchiveChatConversations,
  projectSectionArchiveKeys,
  chatSectionArchiveAddresses,
  projectSectionArchiveCount,
  chatSectionArchiveCount,
}: Pick<DesktopSidebarProps, 'onArchiveProjectsConversations' | 'onArchiveChatConversations'> & {
  projectSectionArchiveKeys: string[]
  chatSectionArchiveAddresses: RuntimeTaskAddress[]
  projectSectionArchiveCount: number
  chatSectionArchiveCount: number
}) {
  const [archiveSectionMode, setArchiveSectionMode] = useState<'projects' | 'chats' | null>(null)
  const [forceArchiveSectionMode, setForceArchiveSectionMode] = useState<
    'projects' | 'chats' | null
  >(null)
  const [isArchivingProjectSection, setIsArchivingProjectSection] = useState(false)
  const [isArchivingChatSection, setIsArchivingChatSection] = useState(false)
  const archiveSectionDialogTestId =
    archiveSectionMode === 'chats'
      ? 'runtime-chat-section-archive-conversations-dialog'
      : 'projects-section-archive-conversations-dialog'
  const archiveSectionDialogCount =
    archiveSectionMode === 'chats' ? chatSectionArchiveCount : projectSectionArchiveCount
  const closeArchiveSectionDialog = () => {
    setArchiveSectionMode(null)
  }
  const forceArchiveSectionDialogTestId =
    forceArchiveSectionMode === 'chats'
      ? 'runtime-chat-section-force-archive-dialog'
      : 'projects-section-force-archive-dialog'
  const runArchiveSectionConversations = async (
    mode: 'projects' | 'chats',
    options?: ArchiveRuntimeTaskOptions
  ) => {
    if (mode === 'projects') {
      if (
        isArchivingProjectSection ||
        !onArchiveProjectsConversations ||
        projectSectionArchiveKeys.length === 0
      )
        return
      setArchiveSectionMode(null)
      setForceArchiveSectionMode(null)
      setIsArchivingProjectSection(true)
      try {
        const result = await onArchiveProjectsConversations(projectSectionArchiveKeys, options)
        if (result?.status === 'dirty_worktree') {
          setForceArchiveSectionMode('projects')
        }
      } finally {
        setIsArchivingProjectSection(false)
      }
      return
    }

    if (mode === 'chats') {
      if (
        isArchivingChatSection ||
        !onArchiveChatConversations ||
        chatSectionArchiveAddresses.length === 0
      )
        return
      setArchiveSectionMode(null)
      setForceArchiveSectionMode(null)
      setIsArchivingChatSection(true)
      try {
        const result = await onArchiveChatConversations(chatSectionArchiveAddresses, options)
        if (result?.status === 'dirty_worktree') {
          setForceArchiveSectionMode('chats')
        }
      } finally {
        setIsArchivingChatSection(false)
      }
    }
  }
  const confirmArchiveSectionConversations = () => {
    if (!archiveSectionMode) return
    void runArchiveSectionConversations(archiveSectionMode)
  }
  const closeForceArchiveSectionDialog = () => {
    setForceArchiveSectionMode(null)
  }
  const confirmForceArchiveSectionConversations = () => {
    if (!forceArchiveSectionMode) return
    void runArchiveSectionConversations(forceArchiveSectionMode, { force: true })
  }
  return {
    archiveSectionMode,
    setArchiveSectionMode,
    forceArchiveSectionMode,
    isArchivingProjectSection,
    isArchivingChatSection,
    archiveSectionDialogTestId,
    archiveSectionDialogCount,
    closeArchiveSectionDialog,
    forceArchiveSectionDialogTestId,
    confirmArchiveSectionConversations,
    closeForceArchiveSectionDialog,
    confirmForceArchiveSectionConversations,
  }
}
