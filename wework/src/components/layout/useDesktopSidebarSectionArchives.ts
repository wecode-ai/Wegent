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
  const isArchiveSectionSubmitting =
    archiveSectionMode === 'projects' ? isArchivingProjectSection : isArchivingChatSection
  const archiveSectionDialogTestId =
    archiveSectionMode === 'chats'
      ? 'runtime-chat-section-archive-conversations-dialog'
      : 'projects-section-archive-conversations-dialog'
  const archiveSectionDialogCount =
    archiveSectionMode === 'chats' ? chatSectionArchiveCount : projectSectionArchiveCount
  const closeArchiveSectionDialog = () => {
    if (!isArchiveSectionSubmitting) {
      setArchiveSectionMode(null)
    }
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
      if (!onArchiveProjectsConversations || projectSectionArchiveKeys.length === 0) return
      setIsArchivingProjectSection(true)
      try {
        const result = await onArchiveProjectsConversations(projectSectionArchiveKeys, options)
        if (result?.status === 'dirty_worktree') {
          setArchiveSectionMode(null)
          setForceArchiveSectionMode('projects')
          return
        }
        setArchiveSectionMode(null)
        setForceArchiveSectionMode(null)
      } finally {
        setIsArchivingProjectSection(false)
      }
      return
    }

    if (mode === 'chats') {
      if (!onArchiveChatConversations || chatSectionArchiveAddresses.length === 0) return
      setIsArchivingChatSection(true)
      try {
        const result = await onArchiveChatConversations(chatSectionArchiveAddresses, options)
        if (result?.status === 'dirty_worktree') {
          setArchiveSectionMode(null)
          setForceArchiveSectionMode('chats')
          return
        }
        setArchiveSectionMode(null)
        setForceArchiveSectionMode(null)
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
    if (!isArchiveSectionSubmitting) {
      setForceArchiveSectionMode(null)
    }
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
    isArchiveSectionSubmitting,
    archiveSectionDialogTestId,
    archiveSectionDialogCount,
    closeArchiveSectionDialog,
    forceArchiveSectionDialogTestId,
    confirmArchiveSectionConversations,
    closeForceArchiveSectionDialog,
    confirmForceArchiveSectionConversations,
  }
}
