// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { Users, User, Plus, FileText, Globe, ArrowLeft, Search } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import { Card } from '@/components/ui/card'
import { KnowledgeBaseCard } from './KnowledgeBaseCard'
import { GroupCard } from './GroupCard'
import { CreateKnowledgeBaseDialog } from './CreateKnowledgeBaseDialog'
import { EditKnowledgeBaseDialog } from './EditKnowledgeBaseDialog'
import { DeleteKnowledgeBaseDialog } from './DeleteKnowledgeBaseDialog'
import { DocumentList } from './DocumentList'
import { useTranslation } from '@/hooks/useTranslation'
import { listGroups } from '@/apis/groups'
import { useKnowledgeBases } from '../hooks/useKnowledgeBases'
import type { Group, GroupRole } from '@/types/group'
import type { KnowledgeBase } from '@/types/knowledge'

type DocumentTabType = 'personal' | 'group' | 'external'

interface DocumentTab {
  id: DocumentTabType
  labelKey: string
  icon: React.ReactNode
  disabled?: boolean
}

const tabs: DocumentTab[] = [
  {
    id: 'personal',
    labelKey: 'knowledge:document.tabs.personal',
    icon: <User className="w-4 h-4" />,
  },
  {
    id: 'group',
    labelKey: 'knowledge:document.tabs.group',
    icon: <Users className="w-4 h-4" />,
  },
  {
    id: 'external',
    labelKey: 'knowledge:document.tabs.external',
    icon: <Globe className="w-4 h-4" />,
    disabled: true,
  },
]

export function KnowledgeDocumentPage() {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<DocumentTabType>('personal')
  const [groups, setGroups] = useState<Group[]>([])
  const [loadingGroups, setLoadingGroups] = useState(true)
  const [selectedKb, setSelectedKb] = useState<KnowledgeBase | null>(null)

  // Dialog states
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [createForGroup, setCreateForGroup] = useState<string | null>(null)
  const [editingKb, setEditingKb] = useState<KnowledgeBase | null>(null)
  const [deletingKb, setDeletingKb] = useState<KnowledgeBase | null>(null)

  // Refresh key for group knowledge bases
  const [groupRefreshKey, setGroupRefreshKey] = useState(0)

  // Personal knowledge bases
  const personalKb = useKnowledgeBases({ scope: 'personal' })

  // Build group role map from loaded groups
  const groupRoleMap = useMemo(() => {
    const roleMap = new Map<string, GroupRole>()
    groups.forEach(group => {
      if (group.my_role) {
        roleMap.set(group.name, group.my_role)
      }
    })
    return roleMap
  }, [groups])

  // Helper function to check if user can manage a knowledge base
  // For personal knowledge bases (namespace === 'default'), always allow
  // For group knowledge bases, check if user has Developer or higher role
  const canManageKnowledgeBase = useCallback(
    (kb: KnowledgeBase) => {
      // Personal knowledge base - always can manage
      if (kb.namespace === 'default') {
        return true
      }
      // Group knowledge base - check role
      const role = groupRoleMap.get(kb.namespace)
      return role === 'Owner' || role === 'Maintainer' || role === 'Developer'
    },
    [groupRoleMap]
  )

  // Load user's groups
  useEffect(() => {
    const loadGroups = async () => {
      try {
        const response = await listGroups()
        setGroups(response.items || [])
      } catch (error) {
        console.error('Failed to load groups:', error)
      } finally {
        setLoadingGroups(false)
      }
    }
    loadGroups()
  }, [])

  const handleCreateKb = (groupName: string | null) => {
    setCreateForGroup(groupName)
    setShowCreateDialog(true)
  }

  const handleCreate = async (data: {
    name: string
    description?: string
    retrieval_config?: Parameters<typeof personalKb.create>[0]['retrieval_config']
  }) => {
    await personalKb.create({
      name: data.name,
      description: data.description,
      namespace: createForGroup || 'default',
      retrieval_config: data.retrieval_config,
    })
    setShowCreateDialog(false)
    // Refresh the appropriate list based on whether it's a group or personal knowledge base
    if (createForGroup) {
      setGroupRefreshKey(prev => prev + 1)
    } else {
      personalKb.refresh()
    }
    setCreateForGroup(null)
  }

  const handleUpdate = async (data: Parameters<typeof personalKb.update>[1]) => {
    if (!editingKb) return
    await personalKb.update(editingKb.id, data)
    // Refresh the appropriate list based on whether it's a group or personal knowledge base
    if (editingKb.namespace !== 'default') {
      // Group knowledge base - trigger refresh via refreshKey
      setGroupRefreshKey(prev => prev + 1)
    }
    setEditingKb(null)
  }

  const handleDelete = async () => {
    if (!deletingKb) return
    await personalKb.remove(deletingKb.id)
    // Refresh the appropriate list based on whether it's a group or personal knowledge base
    if (deletingKb.namespace !== 'default') {
      // Group knowledge base - trigger refresh via refreshKey
      setGroupRefreshKey(prev => prev + 1)
    }
    setDeletingKb(null)
  }

  // Show document list if a knowledge base is selected
  if (selectedKb) {
    return (
      <DocumentList
        knowledgeBase={selectedKb}
        onBack={() => {
          setSelectedKb(null)
          personalKb.refresh()
        }}
        canManage={canManageKnowledgeBase(selectedKb)}
      />
    )
  }

  return (
    <div className="space-y-4">
      {/* Tab navigation - left aligned */}
      <div className="flex items-center gap-1">
        {tabs.map(tab => {
          const isActive = activeTab === tab.id
          return (
            <button
              key={tab.id}
              onClick={() => !tab.disabled && setActiveTab(tab.id)}
              disabled={tab.disabled}
              className={`
                relative flex items-center gap-2 px-4 py-2 text-sm font-medium whitespace-nowrap rounded-md transition-colors duration-200
                ${
                  isActive
                    ? 'text-primary bg-primary/10'
                    : tab.disabled
                      ? 'text-text-muted cursor-not-allowed'
                      : 'text-text-secondary hover:text-text-primary hover:bg-muted'
                }
              `}
            >
              {tab.icon}
              <span>{t(tab.labelKey)}</span>
              {tab.disabled && (
                <span className="ml-1 text-xs px-1.5 py-0.5 rounded-full bg-muted text-text-muted">
                  {t('knowledge:coming_soon')}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* Tab content */}
      <div>
        {activeTab === 'personal' && (
          <PersonalKnowledgeContent
            knowledgeBases={personalKb.knowledgeBases}
            loading={personalKb.loading}
            onSelectKb={setSelectedKb}
            onEditKb={setEditingKb}
            onDeleteKb={setDeletingKb}
            onCreateKb={() => handleCreateKb(null)}
          />
        )}

        {activeTab === 'group' && (
          <GroupKnowledgeContent
            groups={groups}
            loadingGroups={loadingGroups}
            refreshKey={groupRefreshKey}
            onSelectKb={setSelectedKb}
            onEditKb={setEditingKb}
            onDeleteKb={setDeletingKb}
            onCreateKb={handleCreateKb}
          />
        )}

        {activeTab === 'external' && (
          <div className="flex flex-col items-center justify-center py-16 text-text-muted">
            <Globe className="w-12 h-12 mb-4 opacity-50" />
            <p>{t('knowledge:coming_soon')}</p>
          </div>
        )}
      </div>

      {/* Dialogs */}
      <CreateKnowledgeBaseDialog
        open={showCreateDialog}
        onOpenChange={open => {
          setShowCreateDialog(open)
          if (!open) setCreateForGroup(null)
        }}
        onSubmit={handleCreate}
        loading={personalKb.loading}
        scope={createForGroup ? 'group' : 'personal'}
        groupName={createForGroup || undefined}
      />

      <EditKnowledgeBaseDialog
        open={!!editingKb}
        onOpenChange={open => !open && setEditingKb(null)}
        knowledgeBase={editingKb}
        onSubmit={handleUpdate}
        loading={personalKb.loading}
      />

      <DeleteKnowledgeBaseDialog
        open={!!deletingKb}
        onOpenChange={open => !open && setDeletingKb(null)}
        knowledgeBase={deletingKb}
        onConfirm={handleDelete}
        loading={personalKb.loading}
      />
    </div>
  )
}

// Personal knowledge content component
interface PersonalKnowledgeContentProps {
  knowledgeBases: KnowledgeBase[]
  loading: boolean
  onSelectKb: (kb: KnowledgeBase) => void
  onEditKb: (kb: KnowledgeBase) => void
  onDeleteKb: (kb: KnowledgeBase) => void
  onCreateKb: () => void
}

function PersonalKnowledgeContent({
  knowledgeBases,
  loading,
  onSelectKb,
  onEditKb,
  onDeleteKb,
  onCreateKb,
}: PersonalKnowledgeContentProps) {
  const { t } = useTranslation()
  const [searchQuery, setSearchQuery] = useState('')

  const filteredKnowledgeBases = useMemo(() => {
    if (!searchQuery.trim()) return knowledgeBases
    const query = searchQuery.toLowerCase()
    return knowledgeBases.filter(
      kb => kb.name.toLowerCase().includes(query) || kb.description?.toLowerCase().includes(query)
    )
  }, [knowledgeBases, searchQuery])

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    )
  }

  if (knowledgeBases.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16">
        <Card
          padding="lg"
          className="hover:bg-hover transition-colors cursor-pointer flex flex-col items-center justify-center w-64 h-48"
          onClick={onCreateKb}
        >
          <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mb-4">
            <Plus className="w-8 h-8 text-primary" />
          </div>
          <h3 className="font-medium text-base mb-2 text-text-primary">
            {t('knowledge:document.knowledgeBase.create')}
          </h3>
          <p className="text-sm text-text-muted text-center">
            {t('knowledge:document.knowledgeBase.createDesc')}
          </p>
        </Card>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center">
      {/* Search bar */}
      <div className="mb-4 w-full max-w-4xl">
        <div className="relative w-full max-w-md mx-auto">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
          <input
            type="text"
            className="w-full h-9 pl-9 pr-3 text-sm bg-surface border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
            placeholder={t('knowledge:document.knowledgeBase.search')}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      <div className="w-full max-w-4xl grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {/* Add knowledge base card */}
        {!searchQuery && (
          <Card
            padding="sm"
            className="hover:bg-hover transition-colors cursor-pointer flex flex-col items-center justify-center h-[140px]"
            onClick={onCreateKb}
          >
            <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center mb-3">
              <Plus className="w-6 h-6 text-primary" />
            </div>
            <h3 className="font-medium text-sm">{t('knowledge:document.knowledgeBase.create')}</h3>
          </Card>
        )}

        {/* Knowledge base cards */}
        {filteredKnowledgeBases.map(kb => (
          <KnowledgeBaseCard
            key={kb.id}
            knowledgeBase={kb}
            onClick={() => onSelectKb(kb)}
            onEdit={() => onEditKb(kb)}
            onDelete={() => onDeleteKb(kb)}
          />
        ))}
      </div>

      {/* No results message */}
      {searchQuery && filteredKnowledgeBases.length === 0 && (
        <div className="flex flex-col items-center justify-center py-12 text-text-secondary">
          <FileText className="w-12 h-12 mb-4 opacity-50" />
          <p>{t('knowledge:document.knowledgeBase.noResults')}</p>
        </div>
      )}
    </div>
  )
}

// Group knowledge content component
interface GroupKnowledgeContentProps {
  groups: Group[]
  loadingGroups: boolean
  refreshKey: number
  onSelectKb: (kb: KnowledgeBase) => void
  onEditKb: (kb: KnowledgeBase) => void
  onDeleteKb: (kb: KnowledgeBase) => void
  onCreateKb: (groupName: string) => void
}

function GroupKnowledgeContent({
  groups,
  loadingGroups,
  refreshKey,
  onSelectKb,
  onEditKb,
  onDeleteKb,
  onCreateKb,
}: GroupKnowledgeContentProps) {
  const { t } = useTranslation()
  const [selectedGroup, setSelectedGroup] = useState<Group | null>(null)

  if (loadingGroups) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    )
  }

  if (groups.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-text-secondary">
        <Users className="w-12 h-12 mb-4 opacity-50" />
        <p className="text-sm">{t('knowledge:document.noGroupHint')}</p>
      </div>
    )
  }

  // Show knowledge bases for selected group
  if (selectedGroup) {
    return (
      <GroupKnowledgeBaseList
        group={selectedGroup}
        refreshKey={refreshKey}
        onBack={() => setSelectedGroup(null)}
        onSelectKb={onSelectKb}
        onEditKb={onEditKb}
        onDeleteKb={onDeleteKb}
        onCreateKb={() => onCreateKb(selectedGroup.name)}
      />
    )
  }

  // Show group cards grid - centered
  return (
    <div className="flex flex-col items-center">
      <div className="w-full max-w-4xl grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {groups.map(group => (
          <GroupCard key={group.name} group={group} onClick={() => setSelectedGroup(group)} />
        ))}
      </div>
    </div>
  )
}

// Group knowledge base list component
interface GroupKnowledgeBaseListProps {
  group: Group
  refreshKey: number
  onBack: () => void
  onSelectKb: (kb: KnowledgeBase) => void
  onEditKb: (kb: KnowledgeBase) => void
  onDeleteKb: (kb: KnowledgeBase) => void
  onCreateKb: () => void
}

function GroupKnowledgeBaseList({
  group,
  refreshKey,
  onBack,
  onSelectKb,
  onEditKb,
  onDeleteKb,
  onCreateKb,
}: GroupKnowledgeBaseListProps) {
  const { t } = useTranslation()
  const { knowledgeBases, loading, refresh } = useKnowledgeBases({
    scope: 'group',
    groupName: group.name,
  })
  const [searchQuery, setSearchQuery] = useState('')

  // Check permissions based on group role
  // Developer or higher can create/edit, Maintainer or higher can delete
  const groupRole = group.my_role
  const canCreate = groupRole === 'Owner' || groupRole === 'Maintainer' || groupRole === 'Developer'
  const canEdit = groupRole === 'Owner' || groupRole === 'Maintainer' || groupRole === 'Developer'
  const canDelete = groupRole === 'Owner' || groupRole === 'Maintainer'

  // Refresh when refreshKey changes
  useEffect(() => {
    if (refreshKey > 0) {
      refresh()
    }
  }, [refreshKey, refresh])

  const filteredKnowledgeBases = useMemo(() => {
    if (!searchQuery.trim()) return knowledgeBases
    const query = searchQuery.toLowerCase()
    return knowledgeBases.filter(
      kb => kb.name.toLowerCase().includes(query) || kb.description?.toLowerCase().includes(query)
    )
  }, [knowledgeBases, searchQuery])

  const groupDisplayName = group.display_name || group.name || 'Unknown Group'

  return (
    <div>
      {/* Header with back button and group name - left aligned */}
      <div className="flex items-center gap-3 mb-4">
        <button
          onClick={onBack}
          className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-surface transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <Users className="w-5 h-5 text-primary flex-shrink-0" />
        <h2 className="font-medium text-base text-text-primary">{groupDisplayName}</h2>
      </div>

      {/* Content - centered */}
      {loading ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : knowledgeBases.length === 0 ? (
        canCreate ? (
          <div className="flex flex-col items-center justify-center py-16">
            <Card
              padding="lg"
              className="hover:bg-hover transition-colors cursor-pointer flex flex-col items-center justify-center w-64 h-48"
              onClick={onCreateKb}
            >
              <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mb-4">
                <Plus className="w-8 h-8 text-primary" />
              </div>
              <h3 className="font-medium text-base mb-2 text-text-primary">
                {t('knowledge:document.knowledgeBase.create')}
              </h3>
              <p className="text-sm text-text-muted text-center">
                {t('knowledge:document.knowledgeBase.createDesc')}
              </p>
            </Card>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-12 text-text-secondary">
            <FileText className="w-12 h-12 mb-4 opacity-50" />
            <p>{t('knowledge:document.knowledgeBase.empty')}</p>
          </div>
        )
      ) : (
        <div className="flex flex-col items-center">
          {/* Search bar */}
          <div className="mb-4 w-full max-w-4xl">
            <div className="relative w-full max-w-md mx-auto">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
              <input
                type="text"
                className="w-full h-9 pl-9 pr-3 text-sm bg-surface border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
                placeholder={t('knowledge:document.knowledgeBase.search')}
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
              />
            </div>
          </div>

          <div className="w-full max-w-4xl grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {/* Add knowledge base card - only show if user can create */}
            {!searchQuery && canCreate && (
              <Card
                padding="sm"
                className="hover:bg-hover transition-colors cursor-pointer flex flex-col items-center justify-center h-[140px]"
                onClick={onCreateKb}
              >
                <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center mb-3">
                  <Plus className="w-6 h-6 text-primary" />
                </div>
                <h3 className="font-medium text-sm">
                  {t('knowledge:document.knowledgeBase.create')}
                </h3>
              </Card>
            )}

            {/* Knowledge base cards */}
            {filteredKnowledgeBases.map(kb => (
              <KnowledgeBaseCard
                key={kb.id}
                knowledgeBase={kb}
                onClick={() => onSelectKb(kb)}
                onEdit={canEdit ? () => onEditKb(kb) : undefined}
                onDelete={canDelete ? () => onDeleteKb(kb) : undefined}
                canEdit={canEdit}
                canDelete={canDelete}
              />
            ))}
          </div>

          {/* No results message */}
          {searchQuery && filteredKnowledgeBases.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-text-secondary">
              <FileText className="w-12 h-12 mb-4 opacity-50" />
              <p>{t('knowledge:document.knowledgeBase.noResults')}</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
