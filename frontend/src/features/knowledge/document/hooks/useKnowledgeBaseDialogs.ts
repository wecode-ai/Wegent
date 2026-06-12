// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * useKnowledgeBaseDialogs - Hook for managing knowledge base dialog states and handlers.
 *
 * Encapsulates create, edit, delete, and migrate dialog logic to keep the
 * page component focused on layout and navigation.
 */

import { useState, useCallback, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { migrateKnowledgeBaseToGroup } from '@/apis/knowledge'
import type {
  KnowledgeBase,
  KnowledgeBaseCreate,
  KnowledgeBaseType,
  KnowledgeBaseUpdate,
  SummaryModelRef,
} from '@/types/knowledge'
import type { MigrationTargetGroup } from '../components/MigrateKnowledgeBaseDialog'

interface SidebarLike {
  groups: Array<{ id: string; name: string; displayName: string; type: string }>
  selectedGroupId: string | null
  currentUser: { id: number } | null
  selectedKbId: number | null
  refreshAll: () => Promise<void>
  clearSelection: () => void
}

interface UseKnowledgeBaseDialogsParams {
  sidebar: SidebarLike
  saveSummaryModelToPreference: (summaryModelRef: SummaryModelRef | null | undefined) => void
  reloadGroupKbs: () => void
}

export interface UseKnowledgeBaseDialogsReturn {
  // Create dialog
  showCreateDialog: boolean
  setShowCreateDialog: (show: boolean) => void
  createScope: 'personal' | 'group' | 'organization'
  setCreateScope: (scope: 'personal' | 'group' | 'organization') => void
  createGroupName: string | undefined
  setCreateGroupName: (name: string | undefined) => void
  createKbType: KnowledgeBaseType
  setCreateKbType: (type: KnowledgeBaseType) => void
  showGroupSelector: boolean
  setShowGroupSelector: (show: boolean) => void
  isCreating: boolean
  createError: string | null

  // Edit dialog
  editingKb: KnowledgeBase | null
  setEditingKb: (kb: KnowledgeBase | null) => void
  isUpdating: boolean

  // Delete dialog
  deletingKb: KnowledgeBase | null
  setDeletingKb: (kb: KnowledgeBase | null) => void
  isDeleting: boolean

  // Migrate dialog
  migratingKb: KnowledgeBase | null
  setMigratingKb: (kb: KnowledgeBase | null) => void
  isMigrating: boolean
  availableMigrationGroups: MigrationTargetGroup[]

  // Handlers
  handleCreate: (
    data: Omit<KnowledgeBaseCreate, 'namespace'> & { selectedGroupId?: string }
  ) => Promise<void>
  handleUpdate: (data: KnowledgeBaseUpdate) => Promise<void>
  handleDelete: () => Promise<void>
  handleMigrate: (targetGroupName: string) => Promise<void>
  handleCreateKbFromAll: (kbType: KnowledgeBaseType) => void
  handleCreateKbFromGroups: (kbType: KnowledgeBaseType) => void
  handleCreateKbFromGroup: (kbType: KnowledgeBaseType) => void
  canMigrateKb: (kb: { id: number; namespace: string; user_id: number }) => boolean
  resetCreateDialogState: () => void
}

export function useKnowledgeBaseDialogs({
  sidebar,
  saveSummaryModelToPreference,
  reloadGroupKbs,
}: UseKnowledgeBaseDialogsParams): UseKnowledgeBaseDialogsReturn {
  const router = useRouter()

  // Create dialog state
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [createScope, setCreateScope] = useState<'personal' | 'group' | 'organization'>('personal')
  const [createGroupName, setCreateGroupName] = useState<string | undefined>(undefined)
  const [createKbType, setCreateKbType] = useState<KnowledgeBaseType>('notebook')
  const [showGroupSelector, setShowGroupSelector] = useState(false)
  const [isCreating, setIsCreating] = useState(false)

  // Edit dialog state
  const [editingKb, setEditingKb] = useState<KnowledgeBase | null>(null)
  const [isUpdating, setIsUpdating] = useState(false)

  // Delete dialog state
  const [deletingKb, setDeletingKb] = useState<KnowledgeBase | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  // Migrate dialog state
  const [migratingKb, setMigratingKb] = useState<KnowledgeBase | null>(null)
  const [isMigrating, setIsMigrating] = useState(false)

  const resetCreateDialogState = useCallback(() => {
    setCreateGroupName(undefined)
    setCreateScope('personal')
    setCreateKbType('notebook')
    setShowGroupSelector(false)
  }, [])

  const [createError, setCreateError] = useState<string | null>(null)

  const handleCreate = useCallback(
    async (data: Omit<KnowledgeBaseCreate, 'namespace'> & { selectedGroupId?: string }) => {
      setIsCreating(true)
      setCreateError(null)
      try {
        let namespace = 'default'

        if (data.selectedGroupId) {
          const selectedGroup = sidebar.groups.find(g => g.id === data.selectedGroupId)
          if (!selectedGroup) {
            throw new Error(`Selected group ${data.selectedGroupId} not found`)
          }
          if (selectedGroup.type === 'personal') {
            namespace = 'default'
          } else {
            namespace = selectedGroup.name
          }
        } else if (createScope === 'organization') {
          const orgGroup = sidebar.groups.find(g => g.type === 'organization')
          if (!orgGroup) {
            throw new Error('Organization group not found')
          }
          namespace = orgGroup.name
        } else if (createGroupName) {
          namespace = createGroupName
        }

        const kbType = data.kb_type || createKbType

        const { createKnowledgeBase } = await import('@/apis/knowledge')
        await createKnowledgeBase({
          name: data.name,
          description: data.description,
          namespace,
          retrieval_config: data.retrieval_config,
          summary_enabled: data.summary_enabled,
          summary_model_ref: data.summary_model_ref,
          kb_type: kbType,
          guided_questions: data.guided_questions,
          max_calls_per_conversation: data.max_calls_per_conversation,
          exempt_calls_before_check: data.exempt_calls_before_check,
          members: data.members,
        })

        if (data.summary_enabled && data.summary_model_ref) {
          saveSummaryModelToPreference(data.summary_model_ref)
        }
        setShowCreateDialog(false)
        resetCreateDialogState()

        await sidebar.refreshAll()
        if (sidebar.selectedGroupId) {
          reloadGroupKbs()
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to create knowledge base'
        setCreateError(message)
        throw err
      } finally {
        setIsCreating(false)
      }
    },
    [
      createScope,
      createGroupName,
      createKbType,
      sidebar,
      saveSummaryModelToPreference,
      reloadGroupKbs,
      resetCreateDialogState,
    ]
  )

  const handleUpdate = useCallback(
    async (data: KnowledgeBaseUpdate) => {
      if (!editingKb) return
      setIsUpdating(true)
      try {
        const { updateKnowledgeBase } = await import('@/apis/knowledge')
        await updateKnowledgeBase(editingKb.id, data)

        if (data.summary_enabled && data.summary_model_ref) {
          saveSummaryModelToPreference(data.summary_model_ref)
        }

        await sidebar.refreshAll()
        setEditingKb(null)
      } finally {
        setIsUpdating(false)
      }
    },
    [editingKb, sidebar, saveSummaryModelToPreference]
  )

  const handleDelete = useCallback(async () => {
    if (!deletingKb) return
    setIsDeleting(true)
    try {
      const { deleteKnowledgeBase } = await import('@/apis/knowledge')
      await deleteKnowledgeBase(deletingKb.id)

      await sidebar.refreshAll()

      if (deletingKb.id === sidebar.selectedKbId) {
        sidebar.clearSelection()
        router.push('/knowledge?type=document')
      }

      setDeletingKb(null)
    } finally {
      setIsDeleting(false)
    }
  }, [deletingKb, sidebar, router])

  const handleMigrate = useCallback(
    async (targetGroupName: string) => {
      if (!migratingKb) return
      setIsMigrating(true)
      try {
        await migrateKnowledgeBaseToGroup(migratingKb.id, targetGroupName)
        await sidebar.refreshAll()

        if (migratingKb.id === sidebar.selectedKbId) {
          sidebar.clearSelection()
          router.push('/knowledge?type=document')
        }

        setMigratingKb(null)
      } catch (error) {
        throw error
      } finally {
        setIsMigrating(false)
      }
    },
    [migratingKb, sidebar, router]
  )

  const handleCreateKbFromAll = useCallback((kbType: KnowledgeBaseType) => {
    setCreateScope('personal')
    setCreateGroupName(undefined)
    setCreateKbType(kbType)
    setShowGroupSelector(true)
    setShowCreateDialog(true)
  }, [])

  const handleCreateKbFromGroups = useCallback((kbType: KnowledgeBaseType) => {
    setCreateScope('group')
    setCreateGroupName(undefined)
    setCreateKbType(kbType)
    setShowGroupSelector(true)
    setShowCreateDialog(true)
  }, [])

  const handleCreateKbFromGroup = useCallback(
    (kbType: KnowledgeBaseType) => {
      const selectedGroup = sidebar.groups.find(g => g.id === sidebar.selectedGroupId)
      if (!selectedGroup) return

      if (selectedGroup.type === 'personal') {
        setCreateScope('personal')
        setCreateGroupName(undefined)
      } else if (selectedGroup.type === 'organization') {
        setCreateScope('organization')
        setCreateGroupName(undefined)
      } else {
        setCreateScope('group')
        setCreateGroupName(selectedGroup.name)
      }
      setCreateKbType(kbType)
      setShowCreateDialog(true)
    },
    [sidebar.groups, sidebar.selectedGroupId]
  )

  const canMigrateKb = useCallback(
    (kb: { id: number; namespace: string; user_id: number }) => {
      if (kb.namespace !== 'default') return false
      return kb.user_id === sidebar.currentUser?.id
    },
    [sidebar.currentUser]
  )

  const availableMigrationGroups = useMemo((): MigrationTargetGroup[] => {
    return sidebar.groups
      .filter(g => g.type === 'group' || g.type === 'organization')
      .map(g => ({
        id: g.id,
        name: g.name,
        displayName: g.displayName,
        type: g.type as 'group' | 'organization',
      }))
  }, [sidebar.groups])

  return {
    showCreateDialog,
    setShowCreateDialog,
    createScope,
    setCreateScope,
    createGroupName,
    setCreateGroupName,
    createKbType,
    setCreateKbType,
    showGroupSelector,
    setShowGroupSelector,
    isCreating,
    createError,
    editingKb,
    setEditingKb,
    isUpdating,
    deletingKb,
    setDeletingKb,
    isDeleting,
    migratingKb,
    setMigratingKb,
    isMigrating,
    availableMigrationGroups,
    handleCreate,
    handleUpdate,
    handleDelete,
    handleMigrate,
    handleCreateKbFromAll,
    handleCreateKbFromGroups,
    handleCreateKbFromGroup,
    canMigrateKb,
    resetCreateDialogState,
  }
}
