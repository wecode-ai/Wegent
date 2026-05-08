// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * KnowledgeDialogs - Container for all knowledge base CRUD dialogs.
 *
 * Manages dialog state and handlers for create, edit, delete, migrate, and share.
 */

'use client'

import { useState, useCallback } from 'react'
import { listKnowledgeBases, migrateKnowledgeBaseToGroup } from '@/apis/knowledge'
import { saveGlobalModelPreference, type ModelPreference } from '@/utils/modelPreferences'
import { CreateKnowledgeBaseDialog, type AvailableGroup } from './CreateKnowledgeBaseDialog'
import { EditKnowledgeBaseDialog } from './EditKnowledgeBaseDialog'
import { DeleteKnowledgeBaseDialog } from './DeleteKnowledgeBaseDialog'
import { MigrateKnowledgeBaseDialog, type MigrationTargetGroup } from './MigrateKnowledgeBaseDialog'
import { ShareLinkDialog } from '../../permission/components/ShareLinkDialog'
import type {
  KnowledgeBase,
  KnowledgeBaseCreate,
  KnowledgeBaseType,
  KnowledgeBaseUpdate,
  SummaryModelRef,
} from '@/types/knowledge'
import type { KnowledgeGroup } from '../hooks/useKnowledgeSidebar'

export interface KnowledgeDialogsProps {
  /** Groups available for KB creation/migration */
  groups: KnowledgeGroup[]
  /** Currently selected group ID */
  selectedGroupId: string | null
  /** Available groups for create dialog */
  availableGroupsForCreate: AvailableGroup[]
  /** Available groups for migration */
  availableMigrationGroups: MigrationTargetGroup[]
  /** Default team ID for knowledge mode */
  knowledgeDefaultTeamId: number | null
  /** Bind model for knowledge team */
  knowledgeBindModel: string | null
  /** Callback after successful create */
  onCreated: () => Promise<void>
  /** Callback after successful update */
  onUpdated: () => Promise<void>
  /** Callback after successful delete */
  onDeleted: (deletedKbId: number) => Promise<void>
  /** Callback after successful migrate */
  onMigrated: (migratedKbId: number) => Promise<void>
  /** Callback to reload group KBs after create */
  onReloadGroupKbs: (kbs: KnowledgeBase[]) => void
}

export interface KnowledgeDialogsHandle {
  openCreate: (
    kbType: KnowledgeBaseType,
    scope?: 'personal' | 'group' | 'organization',
    groupName?: string,
    showGroupSelector?: boolean
  ) => void
  openEdit: (kb: KnowledgeBase) => void
  openDelete: (kb: KnowledgeBase) => void
  openShare: (kb: KnowledgeBase) => void
  openMigrate: (kb: KnowledgeBase) => void
}

/** Internal hook that exposes dialog state and handlers */
export function useKnowledgeDialogs(props: KnowledgeDialogsProps): KnowledgeDialogsHandle & {
  dialogsElement: React.ReactNode
} {
  const {
    groups,
    selectedGroupId,
    availableGroupsForCreate,
    availableMigrationGroups,
    knowledgeDefaultTeamId,
    knowledgeBindModel,
    onCreated,
    onUpdated,
    onDeleted,
    onMigrated,
    onReloadGroupKbs,
  } = props

  // Dialog open states
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [createScope, setCreateScope] = useState<'personal' | 'group' | 'organization'>('personal')
  const [createGroupName, setCreateGroupName] = useState<string | undefined>(undefined)
  const [createKbType, setCreateKbType] = useState<KnowledgeBaseType>('notebook')
  const [showGroupSelector, setShowGroupSelector] = useState(false)
  const [editingKb, setEditingKb] = useState<KnowledgeBase | null>(null)
  const [deletingKb, setDeletingKb] = useState<KnowledgeBase | null>(null)
  const [sharingKb, setSharingKb] = useState<KnowledgeBase | null>(null)
  const [migratingKb, setMigratingKb] = useState<KnowledgeBase | null>(null)

  // Loading states
  const [isCreating, setIsCreating] = useState(false)
  const [isUpdating, setIsUpdating] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [isMigrating, setIsMigrating] = useState(false)

  // Save summary model preference helper
  const saveSummaryModelToPreference = useCallback(
    (summaryModelRef: SummaryModelRef | null | undefined) => {
      if (!knowledgeDefaultTeamId || !summaryModelRef?.name) return
      const preference: ModelPreference = {
        modelName: summaryModelRef.name,
        modelType: summaryModelRef.type,
        forceOverride: true,
        updatedAt: Date.now(),
      }
      saveGlobalModelPreference(knowledgeDefaultTeamId, preference)
    },
    [knowledgeDefaultTeamId]
  )

  // Open handlers
  const openCreate = useCallback(
    (
      kbType: KnowledgeBaseType,
      scope: 'personal' | 'group' | 'organization' = 'personal',
      groupName?: string,
      showSelector = false
    ) => {
      setCreateScope(scope)
      setCreateGroupName(groupName)
      setCreateKbType(kbType)
      setShowGroupSelector(showSelector)
      setShowCreateDialog(true)
    },
    []
  )

  const openEdit = useCallback((kb: KnowledgeBase) => setEditingKb(kb), [])
  const openDelete = useCallback((kb: KnowledgeBase) => setDeletingKb(kb), [])
  const openShare = useCallback((kb: KnowledgeBase) => setSharingKb(kb), [])
  const openMigrate = useCallback((kb: KnowledgeBase) => setMigratingKb(kb), [])

  // Resolve the namespace for KB creation based on scope/group selection
  const resolveNamespaceForCreate = useCallback(
    (
      dataSelectedGroupId: string | undefined,
      scope: 'personal' | 'group' | 'organization',
      groupName: string | undefined
    ): string => {
      if (dataSelectedGroupId) {
        const group = groups.find(g => g.id === dataSelectedGroupId)
        if (group) {
          return group.type === 'personal' ? 'default' : group.name
        }
      } else if (scope === 'organization') {
        const orgGroup = groups.find(g => g.type === 'organization')
        return orgGroup?.name || 'organization'
      } else if (groupName) {
        return groupName
      }
      return 'default'
    },
    [groups]
  )

  // Perform the actual KB creation API call
  const performCreateKb = useCallback(async (payload: KnowledgeBaseCreate) => {
    const { createKnowledgeBase } = await import('@/apis/knowledge')
    await createKnowledgeBase(payload)
  }, [])

  // Reload KBs for the currently selected group after a create operation
  const reloadSelectedGroupKbs = useCallback(
    async (currentSelectedGroupId: string | null) => {
      if (!currentSelectedGroupId) return
      const selectedGroup = groups.find(g => g.id === currentSelectedGroupId)
      if (!selectedGroup) return
      let kbs: KnowledgeBase[] = []
      if (selectedGroup.type === 'organization') {
        const res = await listKnowledgeBases('organization')
        kbs = res.items || []
      } else if (selectedGroup.type === 'group' && selectedGroup.name) {
        const res = await listKnowledgeBases('group', selectedGroup.name)
        kbs = res.items || []
      }
      onReloadGroupKbs(kbs)
    },
    [groups, onReloadGroupKbs]
  )

  // Reset all create-dialog-related state
  const resetCreateState = useCallback(() => {
    setShowCreateDialog(false)
    setCreateGroupName(undefined)
    setCreateScope('personal')
    setCreateKbType('notebook')
  }, [])

  // CRUD handlers
  const handleCreate = useCallback(
    async (data: Omit<KnowledgeBaseCreate, 'namespace'> & { selectedGroupId?: string }) => {
      setIsCreating(true)
      try {
        const namespace = resolveNamespaceForCreate(
          data.selectedGroupId,
          createScope,
          createGroupName
        )
        const kbType = data.kb_type || createKbType

        await performCreateKb({
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
        })

        if (data.summary_enabled && data.summary_model_ref) {
          saveSummaryModelToPreference(data.summary_model_ref)
        }

        resetCreateState()
        await onCreated()

        // Reload group KBs if a group is selected - errors here must not fail the create flow
        try {
          await reloadSelectedGroupKbs(selectedGroupId)
        } catch (reloadError) {
          console.error('Failed to reload group KBs after create:', reloadError)
        }
      } finally {
        setIsCreating(false)
      }
    },
    [
      createScope,
      createGroupName,
      createKbType,
      selectedGroupId,
      saveSummaryModelToPreference,
      onCreated,
      resolveNamespaceForCreate,
      performCreateKb,
      reloadSelectedGroupKbs,
      resetCreateState,
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
        await onUpdated()
        setEditingKb(null)
      } finally {
        setIsUpdating(false)
      }
    },
    [editingKb, saveSummaryModelToPreference, onUpdated]
  )

  const handleDelete = useCallback(async () => {
    if (!deletingKb) return
    setIsDeleting(true)
    try {
      const { deleteKnowledgeBase } = await import('@/apis/knowledge')
      await deleteKnowledgeBase(deletingKb.id)
      await onDeleted(deletingKb.id)
      setDeletingKb(null)
    } finally {
      setIsDeleting(false)
    }
  }, [deletingKb, onDeleted])

  const handleMigrate = useCallback(
    async (targetGroupName: string) => {
      if (!migratingKb) return
      setIsMigrating(true)
      try {
        await migrateKnowledgeBaseToGroup(migratingKb.id, targetGroupName)
        await onMigrated(migratingKb.id)
        setMigratingKb(null)
      } catch (error) {
        throw error
      } finally {
        setIsMigrating(false)
      }
    },
    [migratingKb, onMigrated]
  )

  const dialogsElement = (
    <>
      <CreateKnowledgeBaseDialog
        open={showCreateDialog}
        onOpenChange={open => {
          if (!isCreating) {
            setShowCreateDialog(open)
            if (!open) {
              setCreateGroupName(undefined)
              setCreateScope('personal')
              setCreateKbType('notebook')
              setShowGroupSelector(false)
            }
          }
        }}
        onSubmit={handleCreate}
        loading={isCreating}
        scope={createScope}
        groupName={createGroupName}
        kbType={createKbType}
        knowledgeDefaultTeamId={knowledgeDefaultTeamId}
        bindModel={knowledgeBindModel}
        showGroupSelector={showGroupSelector}
        availableGroups={availableGroupsForCreate}
        defaultGroupId="personal"
      />
      <EditKnowledgeBaseDialog
        open={!!editingKb}
        onOpenChange={open => !isUpdating && !open && setEditingKb(null)}
        knowledgeBase={editingKb}
        onSubmit={handleUpdate}
        loading={isUpdating}
        knowledgeDefaultTeamId={knowledgeDefaultTeamId}
        bindModel={knowledgeBindModel}
      />
      <DeleteKnowledgeBaseDialog
        open={!!deletingKb}
        onOpenChange={open => !isDeleting && !open && setDeletingKb(null)}
        knowledgeBase={deletingKb}
        onConfirm={handleDelete}
        loading={isDeleting}
      />
      <ShareLinkDialog
        open={!!sharingKb}
        onOpenChange={open => !open && setSharingKb(null)}
        kbId={sharingKb?.id || 0}
        kbName={sharingKb?.name || ''}
      />
      <MigrateKnowledgeBaseDialog
        open={!!migratingKb}
        onOpenChange={open => !isMigrating && !open && setMigratingKb(null)}
        knowledgeBase={migratingKb}
        availableGroups={availableMigrationGroups}
        onMigrate={handleMigrate}
        loading={isMigrating}
      />
    </>
  )

  return {
    openCreate,
    openEdit,
    openDelete,
    openShare,
    openMigrate,
    dialogsElement,
  }
}
