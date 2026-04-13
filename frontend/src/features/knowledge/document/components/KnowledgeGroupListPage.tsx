// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * KnowledgeGroupListPage - Displays knowledge bases in a table format.
 *
 * Shows a table of knowledge bases with search, sort, and create actions.
 * Supports two modes:
 * - Group mode: Shows KBs in a specific group
 * - All mode: Shows all KBs with group info column
 */

'use client'

import { useState, useMemo, useCallback } from 'react'
import {
  ArrowLeft,
  Plus,
  BookOpen,
  Database,
  FolderOpen,
  Star,
  ChevronDown,
  ChevronUp,
  Pencil,
  Trash2,
  FolderOutput,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type {
  KnowledgeBase,
  KnowledgeBaseType,
  KnowledgeBaseWithGroupInfo,
  KnowledgeGroupType,
  MemberRole,
} from '@/types/knowledge'
import { ROLE_DISPLAY_NAMES } from '@/types/base-role'

/** Group info for display */
export interface KbGroupInfo {
  groupId: string
  groupName: string
  groupType: KnowledgeGroupType
}

/** Union type for KB data that can be either KnowledgeBase or KnowledgeBaseWithGroupInfo */
export type KbDataItem = KnowledgeBase | KnowledgeBaseWithGroupInfo

export interface KnowledgeGroupListPageProps {
  /** Group ID (null for "All" mode) */
  groupId: string | null
  /** Group display name */
  groupName: string
  /** Knowledge bases in this group */
  knowledgeBases: KnowledgeBase[]
  /** Knowledge bases with group info (for "All" mode) */
  knowledgeBasesWithGroupInfo?: KnowledgeBaseWithGroupInfo[]
  /** Whether data is loading */
  isLoading: boolean
  /** Go back handler (optional, hidden in "All" mode) */
  onBack?: () => void
  /** Select a knowledge base */
  onSelectKb: (kb: KbDataItem) => void
  /** Create a new knowledge base */
  onCreateKb?: (kbType: KnowledgeBaseType) => void
  /** Edit a knowledge base */
  onEditKb?: (kb: KbDataItem) => void
  /** Delete a knowledge base */
  onDeleteKb?: (kb: KbDataItem) => void
  /** Whether current user can manage a specific KB */
  canManageKb?: (kb: KbDataItem) => boolean
  /** Toggle favorite */
  onToggleFavorite?: (kbId: number, isFavorite: boolean) => void
  /** Check if KB is favorite */
  isFavorite?: (kbId: number) => boolean
  /** Get group info for a KB (for "All" mode) */
  getKbGroupInfo?: (kb: KbDataItem) => KbGroupInfo
  /** Whether this is "All" mode */
  isAllMode?: boolean
  /** Filter by group ID (for "All" mode) */
  filterGroupId?: string | null
  /** Set filter group ID (for "All" mode) */
  onFilterGroupChange?: (groupId: string | null) => void
  /** Available groups for filter (for "All" mode) */
  availableGroups?: Array<{ id: string; name: string; displayName: string }>
  /** Whether this is "Personal" mode (to show created/shared sections) */
  isPersonalMode?: boolean
  /** Knowledge bases created by current user (for personal mode) */
  personalCreatedByMe?: KnowledgeBaseWithGroupInfo[]
  /** Knowledge bases shared with current user (for personal mode) */
  personalSharedWithMe?: KnowledgeBaseWithGroupInfo[]
  /** Migrate a knowledge base to group */
  onMigrateKb?: (kb: KbDataItem) => void
  /** Check if user can migrate a KB (only for personal KBs created by user) */
  canMigrate?: (kb: KbDataItem) => boolean
}

type SortBy = 'name' | 'updated' | 'group' | 'permission' | 'default'
type SortOrder = 'asc' | 'desc'

/** Role priority for sorting (lower number = higher priority) */
const ROLE_PRIORITY: Record<string, number> = {
  Owner: 1,
  Maintainer: 2,
  Developer: 3,
  Reporter: 4,
  RestrictedAnalyst: 5,
}

/** Get role priority for sorting */
function getRolePriority(role: string | null | undefined): number {
  if (!role) return 999 // No role = lowest priority
  return ROLE_PRIORITY[role] ?? 999
}

/** Format relative time */
function formatRelativeTime(
  dateStr: string | undefined,
  tFunc: ReturnType<typeof useTranslation>['t']
): string {
  if (!dateStr) return '--'

  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMinutes = Math.floor(diffMs / (1000 * 60))
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (diffMinutes < 1) {
    return tFunc('document.sidebar.justNow', '刚刚')
  } else if (diffMinutes < 60) {
    return `${diffMinutes} ${tFunc('document.table.minutesAgo', '分钟前')}`
  } else if (diffHours < 24) {
    // Show time like "12:30"
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  } else if (diffDays === 1) {
    return tFunc('document.sidebar.yesterday', '昨天')
  } else if (diffDays < 7) {
    return `${diffDays} ${tFunc('document.table.daysAgo', '天前')}`
  } else {
    // Show date like "2月02日 16:08"
    return date.toLocaleDateString('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }
}

/** Get icon for KB type */
/** Get icon for KB type */
function KbTypeIcon({ kbType, className }: { kbType?: string; className?: string }) {
  const isClassic = kbType === 'classic'
  if (isClassic) {
    return <Database className={cn('text-text-secondary', className)} />
  }
  return <BookOpen className={cn('text-primary', className)} />
}
export function KnowledgeGroupListPage({
  groupId: _groupId,
  groupName,
  knowledgeBases,
  knowledgeBasesWithGroupInfo,
  isLoading,
  onBack,
  onSelectKb,
  onCreateKb,
  onEditKb,
  onDeleteKb,
  canManageKb,
  onToggleFavorite,
  isFavorite,
  getKbGroupInfo,
  isAllMode = false,
  filterGroupId,
  onFilterGroupChange: _onFilterGroupChange,
  availableGroups: _availableGroups,
  isPersonalMode = false,
  personalCreatedByMe = [],
  personalSharedWithMe = [],
  onMigrateKb,
  canMigrate,
}: KnowledgeGroupListPageProps) {
  const { t } = useTranslation('knowledge')
  const [sortBy, setSortBy] = useState<SortBy>('default')
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc')

  // Determine which data source to use
  // Prefer knowledgeBasesWithGroupInfo when available (has my_role field)
  const dataSource = useMemo(() => {
    if (knowledgeBasesWithGroupInfo && knowledgeBasesWithGroupInfo.length > 0) {
      return knowledgeBasesWithGroupInfo
    }
    return knowledgeBases
  }, [knowledgeBasesWithGroupInfo, knowledgeBases])

  // Helper function to get my_role from KB
  const getKbRole = useCallback((kb: KbDataItem): string | null | undefined => {
    if ('my_role' in kb) {
      return kb.my_role
    }
    return undefined
  }, [])

  // Sort function for knowledge bases
  const sortKbs = useCallback(
    (kbs: KbDataItem[]) => {
      return [...kbs].sort((a, b) => {
        let comparison = 0
        switch (sortBy) {
          case 'name':
            comparison = a.name.localeCompare(b.name)
            break
          case 'updated':
            comparison =
              new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime()
            break
          case 'group':
            if (getKbGroupInfo) {
              const groupA = getKbGroupInfo(a).groupName
              const groupB = getKbGroupInfo(b).groupName
              comparison = groupA.localeCompare(groupB)
            }
            break
          case 'permission':
            comparison = getRolePriority(getKbRole(a)) - getRolePriority(getKbRole(b))
            break
          case 'default':
            // Default sort: permission (asc) > group (asc) > name (asc)
            // 1. Sort by permission (higher priority first)
            const permComparison = getRolePriority(getKbRole(a)) - getRolePriority(getKbRole(b))
            if (permComparison !== 0) {
              comparison = permComparison
              break
            }
            // 2. Sort by group name
            if (getKbGroupInfo) {
              const groupA = getKbGroupInfo(a).groupName
              const groupB = getKbGroupInfo(b).groupName
              const groupComparison = groupA.localeCompare(groupB)
              if (groupComparison !== 0) {
                comparison = groupComparison
                break
              }
            }
            // 3. Sort by name
            comparison = a.name.localeCompare(b.name)
            break
          default:
            comparison = 0
        }
        return sortOrder === 'asc' ? comparison : -comparison
      })
    },
    [sortBy, sortOrder, getKbGroupInfo, getKbRole]
  )

  // Filter and sort knowledge bases
  const filteredKbs = useMemo(() => {
    let result = [...dataSource]

    // Filter by group (for "All" mode)
    if (isAllMode && filterGroupId) {
      result = result.filter(kb => {
        if (getKbGroupInfo) {
          const groupInfo = getKbGroupInfo(kb)
          return groupInfo.groupId === filterGroupId
        }
        return true
      })
    }

    return sortKbs(result)
  }, [dataSource, isAllMode, filterGroupId, getKbGroupInfo, sortKbs])

  // Sorted personal KBs for personal mode
  const sortedCreatedByMe = useMemo(
    () => sortKbs(personalCreatedByMe),
    [personalCreatedByMe, sortKbs]
  )
  const sortedSharedWithMe = useMemo(
    () => sortKbs(personalSharedWithMe),
    [personalSharedWithMe, sortKbs]
  )

  const handleToggleFavorite = useCallback(
    (e: React.MouseEvent, kb: KbDataItem) => {
      e.stopPropagation()
      if (onToggleFavorite && isFavorite) {
        onToggleFavorite(kb.id, !isFavorite(kb.id))
      }
    },
    [onToggleFavorite, isFavorite]
  )

  const handleSort = useCallback(
    (column: SortBy) => {
      if (sortBy === column) {
        setSortOrder(prev => (prev === 'asc' ? 'desc' : 'asc'))
      } else {
        setSortBy(column)
        setSortOrder('desc')
      }
    },
    [sortBy]
  )

  const SortIcon = ({ column }: { column: SortBy }) => {
    if (sortBy !== column) return null
    return sortOrder === 'asc' ? (
      <ChevronUp className="w-3.5 h-3.5 ml-1" />
    ) : (
      <ChevronDown className="w-3.5 h-3.5 ml-1" />
    )
  }

  // Render table header
  const renderTableHeader = (showGroupColumn: boolean) => (
    <thead className="sticky top-0 bg-surface border-b border-border">
      <tr className="text-left text-sm text-text-secondary">
        <th className="px-6 py-3 font-medium w-[35%]">
          <button
            className="flex items-center hover:text-text-primary transition-colors"
            onClick={() => handleSort('name')}
          >
            {t('document.table.name', '名称')}
            <SortIcon column="name" />
          </button>
        </th>
        {showGroupColumn && (
          <th className="px-6 py-3 font-medium w-[20%]">
            <button
              className="flex items-center hover:text-text-primary transition-colors"
              onClick={() => handleSort('group')}
            >
              {t('document.table.group', '归属小组')}
              <SortIcon column="group" />
            </button>
          </th>
        )}
        <th className="px-6 py-3 font-medium w-[15%]">{t('document.table.permission', '权限')}</th>
        <th className="px-6 py-3 font-medium w-[15%]">
          <button
            className="flex items-center hover:text-text-primary transition-colors"
            onClick={() => handleSort('updated')}
          >
            {t('document.table.lastAccess', '最近访问')}
            <SortIcon column="updated" />
          </button>
        </th>
        <th className="px-6 py-3 font-medium w-[15%] text-right">
          {t('document.table.actions', '操作')}
        </th>
      </tr>
    </thead>
  )

  // Render table rows
  const renderTableRows = (kbs: KbDataItem[], showGroupColumn: boolean) => (
    <tbody>
      {kbs.map(kb => (
        <KnowledgeBaseRow
          key={kb.id}
          kb={kb}
          onClick={() => onSelectKb(kb)}
          onEdit={onEditKb && canManageKb?.(kb) ? () => onEditKb(kb) : undefined}
          onDelete={onDeleteKb && canManageKb?.(kb) ? () => onDeleteKb(kb) : undefined}
          onMigrate={onMigrateKb ? () => onMigrateKb(kb) : undefined}
          onToggleFavorite={onToggleFavorite ? e => handleToggleFavorite(e, kb) : undefined}
          isFavorite={isFavorite?.(kb.id)}
          showGroupInfo={showGroupColumn}
          groupInfo={getKbGroupInfo?.(kb)}
          canMigrate={canMigrate?.(kb)}
          tFunc={t}
        />
      ))}
    </tbody>
  )

  // Render personal mode content with separate sections
  const renderPersonalModeContent = () => {
    const hasCreated = sortedCreatedByMe.length > 0
    const hasShared = sortedSharedWithMe.length > 0

    if (!hasCreated && !hasShared) {
      return (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <FolderOpen className="w-12 h-12 text-text-muted mb-4" />
          <h3 className="text-lg font-medium text-text-primary mb-2">
            {t('document.knowledgeBase.empty', '暂无知识库')}
          </h3>
          <p className="text-sm text-text-muted mb-4">
            {t('document.knowledgeBase.createDesc', '点击上方按钮创建第一个知识库')}
          </p>
        </div>
      )
    }

    return (
      <div className="space-y-6">
        {/* Created by me section */}
        <div>
          <h3 className="px-6 py-3 text-sm font-medium text-text-secondary bg-surface-hover border-b border-border">
            {t('document.personalGroups.createdByMe', '我创建的')}
            <span className="ml-2 text-text-muted">({sortedCreatedByMe.length})</span>
          </h3>
          {hasCreated ? (
            <table className="w-full table-fixed min-w-0">
              {renderTableHeader(false)}
              {renderTableRows(sortedCreatedByMe, false)}
            </table>
          ) : (
            <div className="px-6 py-8 text-center text-text-muted">
              <p>{t('document.personalGroups.noCreated', '您还没有创建任何知识库')}</p>
              <p className="text-sm mt-1">
                {t('document.personalGroups.createdDesc', '点击上方按钮创建您的第一个知识库')}
              </p>
            </div>
          )}
        </div>

        {/* Shared with me section */}
        <div>
          <h3 className="px-6 py-3 text-sm font-medium text-text-secondary bg-surface-hover border-b border-border">
            {t('document.personalGroups.sharedWithMe', '分享给我的')}
            <span className="ml-2 text-text-muted">({sortedSharedWithMe.length})</span>
          </h3>
          {hasShared ? (
            <table className="w-full table-fixed min-w-0">
              {renderTableHeader(true)}
              {renderTableRows(sortedSharedWithMe, true)}
            </table>
          ) : (
            <div className="px-6 py-8 text-center text-text-muted">
              <p>{t('document.personalGroups.noShared', '暂没有分享给您的知识库')}</p>
              <p className="text-sm mt-1">
                {t(
                  'document.personalGroups.sharedDesc',
                  '当其他用户分享知识库给您时，将显示在这里'
                )}
              </p>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div
      className="flex flex-col h-full overflow-hidden pl-4"
      data-testid="knowledge-group-list-page"
    >
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 border-b border-border ml-2">
        {/* Back button - only show in group mode */}
        {!isAllMode && onBack && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onBack}
            className="flex-shrink-0"
            data-testid="back-button"
          >
            <ArrowLeft className="w-4 h-4" />
          </Button>
        )}
        <h2 className="text-lg font-semibold flex-1 truncate">
          {isAllMode ? t('document.allKnowledgeBases', '全部知识库') : groupName}
        </h2>
        {onCreateKb && (
          <Button
            variant="primary"
            size="sm"
            onClick={() => onCreateKb('notebook')}
            data-testid="create-kb-button"
          >
            <Plus className="w-4 h-4 mr-1" />
            {t('document.knowledgeBase.create', '新建知识库')}
          </Button>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden min-w-0">
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Spinner />
          </div>
        ) : isPersonalMode ? (
          // Personal mode: show separate sections for created and shared
          renderPersonalModeContent()
        ) : filteredKbs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <FolderOpen className="w-12 h-12 text-text-muted mb-4" />
            <h3 className="text-lg font-medium text-text-primary mb-2">
              {t('document.knowledgeBase.empty', '暂无知识库')}
            </h3>
            <p className="text-sm text-text-muted mb-4">
              {t('document.knowledgeBase.createDesc', '点击上方按钮创建第一个知识库')}
            </p>
          </div>
        ) : (
          <table className="w-full table-fixed min-w-0">
            {renderTableHeader(isAllMode)}
            {renderTableRows(filteredKbs, isAllMode)}
          </table>
        )}
      </div>
    </div>
  )
}

// Knowledge base table row component
interface KnowledgeBaseRowProps {
  kb: KbDataItem
  onClick: () => void
  onEdit?: () => void
  onDelete?: () => void
  onMigrate?: () => void
  onToggleFavorite?: (e: React.MouseEvent) => void
  isFavorite?: boolean
  showGroupInfo?: boolean
  groupInfo?: KbGroupInfo
  canMigrate?: boolean
  tFunc: ReturnType<typeof useTranslation>['t']
}

function KnowledgeBaseRow({
  kb,
  onClick,
  onEdit,
  onDelete,
  onMigrate,
  onToggleFavorite: _onToggleFavorite,
  isFavorite,
  showGroupInfo,
  groupInfo,
  canMigrate,
  tFunc,
}: KnowledgeBaseRowProps) {
  return (
    <tr
      className="border-b border-border hover:bg-surface-hover cursor-pointer transition-colors"
      onClick={onClick}
      data-testid={`kb-row-${kb.id}`}
    >
      {/* Name column */}
      <td className="px-6 py-3 overflow-hidden">
        <div className="flex items-center gap-3 min-w-0">
          <KbTypeIcon kbType={kb.kb_type} className="w-5 h-5 flex-shrink-0" />
          <span className="text-sm font-medium text-text-primary truncate">{kb.name}</span>
          {isFavorite && <Star className="w-4 h-4 text-yellow-500 fill-yellow-500 flex-shrink-0" />}
        </div>
      </td>

      {/* Group column - only in "All" mode */}
      {showGroupInfo && (
        <td className="px-6 py-3 text-text-secondary overflow-hidden">
          <span className="truncate block">{groupInfo ? groupInfo.groupName : '--'}</span>
        </td>
      )}

      {/* Permission column */}
      <td className="px-6 py-3 text-text-secondary whitespace-nowrap">
        {'my_role' in kb && kb.my_role ? ROLE_DISPLAY_NAMES[kb.my_role as MemberRole] : '--'}
      </td>

      {/* Last access column */}
      <td className="px-6 py-3 text-text-secondary whitespace-nowrap">
        {formatRelativeTime(kb.updated_at, tFunc)}
      </td>

      {/* Actions column - Migrate, Edit and Delete */}
      <td className="px-6 py-3">
        <div className="flex items-center justify-end gap-1">
          {canMigrate && onMigrate && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={e => {
                e.stopPropagation()
                onMigrate()
              }}
              title={tFunc('document.migrate.title', '迁移到群组')}
              data-testid={`migrate-kb-${kb.id}`}
            >
              <FolderOutput className="w-4 h-4 text-text-muted hover:text-primary transition-colors" />
            </Button>
          )}
          {onEdit && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={e => {
                e.stopPropagation()
                onEdit()
              }}
              title={tFunc('document.table.edit', '编辑')}
              data-testid={`edit-kb-${kb.id}`}
            >
              <Pencil className="w-4 h-4 text-text-muted" />
            </Button>
          )}
          {onDelete && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={e => {
                e.stopPropagation()
                onDelete()
              }}
              title={tFunc('document.table.delete', '删除')}
              data-testid={`delete-kb-${kb.id}`}
            >
              <Trash2 className="w-4 h-4 text-text-muted hover:text-error" />
            </Button>
          )}
        </div>
      </td>
    </tr>
  )
}

export default KnowledgeGroupListPage
