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

import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { COMPANY_SPACE_FILTER, PERSONAL_SPACE_FILTER, getListedPermission } from '../navigation'
import { Input } from '@/components/ui/input'
import { getKbShareSourceText } from '@/features/knowledge/utils/share-source'
import {
  ArrowLeft,
  Plus,
  FolderOpen,
  Star,
  ChevronDown,
  ChevronUp,
  SlidersHorizontal,
} from 'lucide-react'
import { KnowledgeBaseIcon } from './KnowledgeBaseIcon'
import {
  isInKnowledgeBaseCategory,
  KnowledgeBaseCategoryFilter,
  type KnowledgeBaseCategory,
} from './KnowledgeBaseCategoryFilter'
import { AdvancedKnowledgeToggle } from './AdvancedKnowledgeToggle'
import { KnowledgeLibraryFilter, type KnowledgeTeamOption } from './KnowledgeLibraryFilter'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { getRuntimeConfigSync } from '@/lib/runtime-config'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table'
import { useTranslation } from '@/hooks/useTranslation'
import type {
  KnowledgeBase,
  KnowledgeBaseType,
  KnowledgeBaseWithGroupInfo,
  KbGroupInfo,
} from '@/types/knowledge'
import { KnowledgeBaseActions } from './KnowledgeBaseActions'
import { KnowledgeMobileList } from './KnowledgeMobileList'
import { hasAdvancedKnowledgeBases } from '../hooks/useAdvancedKnowledgeMode'

/** Union type for KB data that can be either KnowledgeBase or KnowledgeBaseWithGroupInfo */
export type KbDataItem = KnowledgeBase | KnowledgeBaseWithGroupInfo

export interface KnowledgeGroupListPageProps {
  mobile?: boolean
  onViewPermissions?: (kb: KbDataItem) => void
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
  onCreateKbInSpace?: (kbType: KnowledgeBaseType) => void
  /** Whether advanced knowledge bases exist or are enabled by runtime config */
  hasAdvancedKnowledge?: boolean
  /** Whether advanced knowledge bases (code wikis) are visible */
  showAdvancedKnowledge?: boolean
  /** Update advanced knowledge base visibility */
  onShowAdvancedKnowledgeChange?: (show: boolean) => void
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
  showCompanySpace?: boolean
  /** Selected team identity or personal-space filter (for "All" mode). */
  filterGroupId?: string | null
  /** Set filter group ID (for "All" mode) */
  onFilterGroupChange?: (groupId: string | null) => void
  /** Available groups for filter (for "All" mode) */
  availableGroups?: Omit<KnowledgeTeamOption, 'kbCount'>[]
  /** Whether this is "Personal" mode (to show created/shared sections) */
  isPersonalMode?: boolean
  /** Knowledge bases created by current user (for personal mode) */
  personalCreatedByMe?: KnowledgeBaseWithGroupInfo[]
  /** Knowledge bases shared with current user (for personal mode) */
  personalSharedWithMe?: KnowledgeBaseWithGroupInfo[]
  /** Native group knowledge bases (for group section mode) */
  groupNativeKbs?: KnowledgeBaseWithGroupInfo[]
  /** Shared-into-group knowledge bases (for group section mode) */
  groupSharedKbs?: KnowledgeBaseWithGroupInfo[]
  /** Migrate a knowledge base to group */
  onMigrateKb?: (kb: KbDataItem) => void
  /** Check if user can migrate a KB (only for personal KBs created by user) */
  canMigrate?: (kb: KbDataItem) => boolean
}

type SortBy = 'name' | 'created' | 'updated' | 'group' | 'permission'
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

/** Format date time: current year shows "x月xx日 xx:xx", previous years show "xxxx年x月xx日 xx:xx" */
function formatDateTime(dateStr: string | undefined, locale: string): string {
  if (!dateStr) return '--'

  const date = new Date(dateStr)
  const now = new Date()
  const isCurrentYear = date.getFullYear() === now.getFullYear()

  // Use locale-aware formatting
  if (isCurrentYear) {
    // Current year: "5月19日 14:30"
    return date.toLocaleDateString(locale, {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } else {
    // Previous years: "2025年5月19日 14:30"
    return date.toLocaleDateString(locale, {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }
}

function matchesSpaceFilter(kb: KbDataItem, spaceId: string): boolean {
  const level = 'namespace_level' in kb ? kb.namespace_level : null
  if (spaceId === COMPANY_SPACE_FILTER) return level === 'organization'
  if (spaceId === PERSONAL_SPACE_FILTER) {
    return level ? level === 'personal' : kb.namespace === 'default'
  }
  return (!level || level === 'group') && kb.namespace === spaceId.replace(/^group-/, '')
}

export function KnowledgeGroupListPage({
  mobile = false,
  onViewPermissions,
  groupId,
  groupName,
  knowledgeBases,
  knowledgeBasesWithGroupInfo,
  isLoading,
  onBack,
  onSelectKb,
  onCreateKb,
  onCreateKbInSpace,
  hasAdvancedKnowledge = false,
  showAdvancedKnowledge = false,
  onShowAdvancedKnowledgeChange,
  onEditKb,
  onDeleteKb,
  canManageKb,
  onToggleFavorite,
  isFavorite,
  getKbGroupInfo,
  isAllMode = false,
  showCompanySpace = false,
  filterGroupId,
  onFilterGroupChange,
  availableGroups,
  isPersonalMode = false,
  personalCreatedByMe = [],
  personalSharedWithMe = [],
  groupNativeKbs = [],
  groupSharedKbs = [],
  onMigrateKb,
  canMigrate,
}: KnowledgeGroupListPageProps) {
  const isGroupSectionMode = groupNativeKbs.length > 0 || groupSharedKbs.length > 0
  const { t } = useTranslation('knowledge')
  const [search, setSearch] = useState('')
  const resultHeadingRef = useRef<HTMLHeadingElement>(null)
  const [sortBy, setSortBy] = useState<SortBy>('created')
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc')
  const [category, setCategory] = useState<KnowledgeBaseCategory>('all')
  const searchQuery = search.trim().toLocaleLowerCase()
  const supportsSpaceFilter = isAllMode && groupId !== 'organization'
  const spaceFilter = supportsSpaceFilter ? filterGroupId : null
  // Determine which data source to use
  // Prefer knowledgeBasesWithGroupInfo when available (has my_role field)
  const dataSource = useMemo(() => {
    if (knowledgeBasesWithGroupInfo) {
      return knowledgeBasesWithGroupInfo
    }
    return knowledgeBases
  }, [knowledgeBasesWithGroupInfo, knowledgeBases])

  const showCodeCategory = useMemo(
    () =>
      showAdvancedKnowledge &&
      (getRuntimeConfigSync().enableCodeWiki ||
        hasAdvancedKnowledgeBases([
          ...dataSource,
          ...personalCreatedByMe,
          ...personalSharedWithMe,
          ...groupNativeKbs,
          ...groupSharedKbs,
        ])),
    [
      dataSource,
      groupNativeKbs,
      groupSharedKbs,
      personalCreatedByMe,
      personalSharedWithMe,
      showAdvancedKnowledge,
    ]
  )

  useEffect(() => {
    if (!showCodeCategory && category !== 'all') {
      setCategory('all')
    }
  }, [category, showCodeCategory])

  const filterByCategory = useCallback(
    (kbs: KbDataItem[]) => kbs.filter(kb => isInKnowledgeBaseCategory(kb.kb_type, category)),
    [category]
  )

  const getKbRole = getListedPermission
  const showPermissionInfo = dataSource.some(kb => getListedPermission(kb) !== null)

  // Sort function for knowledge bases
  const sortKbs = useCallback(
    (kbs: KbDataItem[]) => {
      // Pre-compute timestamps for date-based sorting to avoid creating Date objects in each comparison
      const withTimestamps = kbs.map(kb => ({
        kb,
        createdTime: kb.created_at ? new Date(kb.created_at).getTime() : 0,
        updatedTime: kb.updated_at ? new Date(kb.updated_at).getTime() : 0,
      }))

      withTimestamps.sort((a, b) => {
        let comparison = 0
        switch (sortBy) {
          case 'name':
            comparison = a.kb.name.localeCompare(b.kb.name)
            break
          case 'created':
            comparison = a.createdTime - b.createdTime
            break
          case 'updated':
            comparison = a.updatedTime - b.updatedTime
            break
          case 'group':
            if (getKbGroupInfo) {
              const groupA = getKbGroupInfo(a.kb).groupName
              const groupB = getKbGroupInfo(b.kb).groupName
              comparison = groupA.localeCompare(groupB)
            }
            break
          case 'permission':
            comparison = getRolePriority(getKbRole(a.kb)) - getRolePriority(getKbRole(b.kb))
            break
          default:
            comparison = 0
        }
        return sortOrder === 'asc' ? comparison : -comparison
      })

      return withTimestamps.map(item => item.kb)
    },
    [sortBy, sortOrder, getKbGroupInfo, getKbRole]
  )

  // Facet counts and rows share one deduplicated scope before the team filter.
  const candidateKbs = useMemo(() => {
    const seen = new Set<number>()
    return filterByCategory(dataSource).filter(kb => {
      if (!kb.name.toLocaleLowerCase().includes(searchQuery)) return false
      if (seen.has(kb.id)) return false
      seen.add(kb.id)
      return true
    })
  }, [dataSource, filterByCategory, searchQuery])

  const filterGroups = useMemo(
    () =>
      (availableGroups ?? []).map(group => ({
        ...group,
        kbCount: candidateKbs.filter(kb => matchesSpaceFilter(kb, group.id)).length,
      })),
    [availableGroups, candidateKbs]
  )

  const filteredKbs = useMemo(
    () => sortKbs(candidateKbs.filter(kb => !spaceFilter || matchesSpaceFilter(kb, spaceFilter))),
    [candidateKbs, spaceFilter, sortKbs]
  )
  const hasActiveFilters = Boolean(searchQuery || category !== 'all' || spaceFilter)
  const canClearFilters = Boolean(
    searchQuery || category !== 'all' || (spaceFilter && onFilterGroupChange)
  )
  const clearFilters = () => {
    setSearch('')
    setCategory('all')
    onFilterGroupChange?.(null)
    resultHeadingRef.current?.focus()
  }

  // Determine whether to show the "from" column
  const showFromColumn = !isPersonalMode && !isAllMode

  // Sorted personal KBs for personal mode
  const sortedCreatedByMe = useMemo(
    () => sortKbs(filterByCategory(personalCreatedByMe)),
    [personalCreatedByMe, filterByCategory, sortKbs]
  )
  const sortedSharedWithMe = useMemo(
    () => sortKbs(filterByCategory(personalSharedWithMe)),
    [personalSharedWithMe, filterByCategory, sortKbs]
  )
  const sortedNative = useMemo(
    () => sortKbs(filterByCategory(groupNativeKbs)),
    [groupNativeKbs, filterByCategory, sortKbs]
  )
  const sortedShared = useMemo(
    () => sortKbs(filterByCategory(groupSharedKbs)),
    [groupSharedKbs, filterByCategory, sortKbs]
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
  const renderTableHeader = (
    showGroupColumn: boolean,
    showFromColumn: boolean,
    groupColumnTitle?: string
  ) => (
    <TableHeader className="sticky top-0 bg-surface">
      <TableRow className="text-left text-sm text-text-secondary">
        <TableHead className="h-auto px-4 py-2 font-medium">
          <button
            className="flex items-center hover:text-text-primary transition-colors"
            onClick={() => handleSort('name')}
          >
            {t('document.table.name', '名称')}
            <SortIcon column="name" />
          </button>
        </TableHead>
        {showGroupColumn && (
          <TableHead className="h-auto px-4 py-2 font-medium w-[15%]">
            <button
              className="flex items-center hover:text-text-primary transition-colors"
              onClick={() => handleSort('group')}
            >
              {groupColumnTitle || t('document.table.group', '归属')}
              <SortIcon column="group" />
            </button>
          </TableHead>
        )}
        {showFromColumn && (
          <TableHead className="h-auto px-4 py-2 font-medium w-[12%]">
            {t('document.table.from', '来自')}
          </TableHead>
        )}
        {showPermissionInfo && (
          <TableHead className="h-auto w-24 px-3 py-2 font-medium">
            {t('document.table.permission', '权限')}
          </TableHead>
        )}
        <TableHead className="h-auto w-28 px-3 py-2 font-medium">
          <button
            className="flex items-center hover:text-text-primary transition-colors"
            onClick={() => handleSort('created')}
          >
            {t('document.table.createdAt', '创建时间')}
            <SortIcon column="created" />
          </button>
        </TableHead>
        <TableHead className="hidden h-auto w-28 px-3 py-2 font-medium xl:table-cell">
          <button
            className="flex items-center hover:text-text-primary transition-colors"
            onClick={() => handleSort('updated')}
          >
            {t('document.table.updatedAt', '更新时间')}
            <SortIcon column="updated" />
          </button>
        </TableHead>
        <TableHead className="h-auto w-28 px-2 py-2 font-medium text-right">
          {t('document.table.actions', '操作')}
        </TableHead>
      </TableRow>
    </TableHeader>
  )

  // Render table rows
  const renderTableRows = (
    kbs: KbDataItem[],
    showGroupColumn: boolean,
    showFromColumn: boolean
  ) => (
    <TableBody>
      {kbs.map(kb => (
        <KnowledgeBaseRow
          key={kb.id}
          kb={kb}
          onClick={() => onSelectKb(kb)}
          onPermissions={onViewPermissions ? () => onViewPermissions(kb) : undefined}
          onEdit={onEditKb && canManageKb?.(kb) ? () => onEditKb(kb) : undefined}
          onDelete={onDeleteKb && canManageKb?.(kb) ? () => onDeleteKb(kb) : undefined}
          onMigrate={onMigrateKb ? () => onMigrateKb(kb) : undefined}
          onToggleFavorite={onToggleFavorite ? e => handleToggleFavorite(e, kb) : undefined}
          isFavorite={isFavorite?.(kb.id)}
          showPermissionInfo={showPermissionInfo}
          showGroupInfo={showGroupColumn}
          showFromInfo={showFromColumn}
          groupInfo={getKbGroupInfo?.(kb)}
          canMigrate={canMigrate?.(kb)}
        />
      ))}
    </TableBody>
  )

  const renderEmptyState = () => {
    const emptyTitle = hasActiveFilters
      ? t('document.navigation.noFilteredKnowledge')
      : groupId === 'shared'
        ? t('document.navigation.emptyShared')
        : groupId === 'organization'
          ? t('document.navigation.emptyCompany')
          : t('document.knowledgeBase.empty')

    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <FolderOpen className="w-12 h-12 text-text-muted mb-4" />
        <h3 className="text-lg font-medium text-text-primary mb-2">{emptyTitle}</h3>
        {hasActiveFilters ? (
          <>
            <p className="mb-4 text-sm text-text-muted">{t('document.navigation.refineFilters')}</p>
            {canClearFilters && (
              <Button
                variant="outline"
                className="min-h-11 min-w-11"
                data-testid="knowledge-clear-filters"
                onClick={clearFilters}
              >
                {t('document.navigation.clearFilters')}
              </Button>
            )}
          </>
        ) : groupId === 'shared' || groupId === 'organization' ? (
          <p className="text-sm text-text-muted">
            {t(
              groupId === 'shared'
                ? 'document.navigation.emptySharedHint'
                : 'document.navigation.emptyCompanyHint'
            )}
          </p>
        ) : onCreateKb ? (
          <p className="text-sm text-text-muted mb-4">{t('document.knowledgeBase.createDesc')}</p>
        ) : null}
      </div>
    )
  }

  // Render personal mode content with separate sections
  const renderPersonalModeContent = () => {
    const hasCreated = sortedCreatedByMe.length > 0
    const hasShared = sortedSharedWithMe.length > 0

    if (!hasCreated && !hasShared) {
      return renderEmptyState()
    }

    return (
      <div className="space-y-6">
        {/* Created by me section */}
        <div>
          <h3 className="px-4 py-2 text-sm font-medium text-text-secondary bg-surface-hover border-b border-border">
            {t('document.personalGroups.createdByMe', '我创建的')}
            <span className="ml-2 text-text-muted">({sortedCreatedByMe.length})</span>
          </h3>
          {hasCreated ? (
            <Table className="w-full min-w-[720px] table-fixed">
              {renderTableHeader(false, false)}
              {renderTableRows(sortedCreatedByMe, false, false)}
            </Table>
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
          <h3 className="px-4 py-2 text-sm font-medium text-text-secondary bg-surface-hover border-b border-border">
            {t('document.personalGroups.sharedWithMe', '分享给我的')}
            <span className="ml-2 text-text-muted">({sortedSharedWithMe.length})</span>
          </h3>
          {hasShared ? (
            <Table className="w-full min-w-[720px] table-fixed">
              {renderTableHeader(true, true, t('document.table.belongsTo', '归属'))}
              {renderTableRows(sortedSharedWithMe, true, true)}
            </Table>
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

  // Render group section mode with native and shared sub-sections
  const renderGroupSectionContent = () => {
    const hasNative = sortedNative.length > 0
    const hasShared = sortedShared.length > 0

    if (!hasNative && !hasShared) {
      return renderEmptyState()
    }

    return (
      <div className="space-y-6">
        {/* Native group KBs section */}
        <div>
          <h3 className="px-4 py-2 text-sm font-medium text-text-secondary bg-surface-hover border-b border-border">
            {t('document.groupSections.native', '创建')}
            <span className="ml-2 text-text-muted">({sortedNative.length})</span>
          </h3>
          {hasNative ? (
            <Table className="w-full min-w-[720px] table-fixed">
              {renderTableHeader(false, false)}
              {renderTableRows(sortedNative, false, false)}
            </Table>
          ) : (
            <div className="px-6 py-8 text-center text-text-muted">
              <p>{t('document.groupSections.noNative', '暂无群组知识库')}</p>
            </div>
          )}
        </div>

        {/* Shared-into-group KBs section */}
        <div>
          <h3 className="px-4 py-2 text-sm font-medium text-text-secondary bg-surface-hover border-b border-border">
            {t('document.groupSections.shared', '分享')}
            <span className="ml-2 text-text-muted">({sortedShared.length})</span>
          </h3>
          {hasShared ? (
            <Table className="w-full min-w-[720px] table-fixed">
              {renderTableHeader(false, true)}
              {renderTableRows(sortedShared, false, true)}
            </Table>
          ) : (
            <div className="px-6 py-8 text-center text-text-muted">
              <p>{t('document.groupSections.noShared', '暂无分享的知识库')}</p>
            </div>
          )}
        </div>
      </div>
    )
  }

  const renderFilterControls = () => (
    <>
      <KnowledgeBaseCategoryFilter
        value={category}
        onValueChange={setCategory}
        showCode={showCodeCategory}
      />
      {hasAdvancedKnowledge && onShowAdvancedKnowledgeChange && (
        <AdvancedKnowledgeToggle
          id="show-advanced-knowledge"
          testId="show-advanced-knowledge-toggle"
          checked={showAdvancedKnowledge}
          onCheckedChange={onShowAdvancedKnowledgeChange}
        />
      )}
      {mobile && (
        <div className="flex max-w-full items-center gap-2">
          <Select value={sortBy} onValueChange={value => setSortBy(value as SortBy)}>
            <SelectTrigger
              className="min-h-11 min-w-11 w-32 max-w-full bg-base"
              data-testid="knowledge-sort"
              aria-label={t('document.navigation.sortLabel')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent
              collisionPadding={8}
              className="max-h-[min(16rem,var(--radix-select-content-available-height))]"
            >
              {(['name', 'group', 'permission', 'created', 'updated'] as SortBy[]).map(value => (
                <SelectItem
                  key={value}
                  value={value}
                  className="min-h-11"
                  data-testid={`knowledge-sort-option-${value}`}
                >
                  {t('document.navigation.sort.' + value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            className="min-h-11 min-w-11"
            data-testid="knowledge-sort-direction"
            aria-label={t(
              sortOrder === 'asc'
                ? 'document.navigation.ascending'
                : 'document.navigation.descending'
            )}
            onClick={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}
          >
            {sortOrder === 'asc' ? <ChevronUp /> : <ChevronDown />}
          </Button>
        </div>
      )}
    </>
  )

  return (
    <div
      className={`flex flex-col h-full overflow-hidden ${mobile ? '' : 'pl-4'}`}
      data-testid="knowledge-group-list-page"
    >
      {/* Header */}
      <div
        className={`flex flex-col gap-3 py-4 border-b border-border ${mobile ? 'px-4' : 'px-6 ml-2'}`}
      >
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-40 flex-1 items-center gap-2">
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
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <h2
                ref={resultHeadingRef}
                tabIndex={-1}
                data-testid="knowledge-result-title"
                className="truncate text-lg font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                {groupName}
              </h2>
              <span
                className="shrink-0 text-sm tabular-nums text-text-muted"
                data-testid="knowledge-result-count"
              >
                {filteredKbs.length}
              </span>
            </div>
          </div>
          <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">
            {onCreateKbInSpace && (
              <Button
                variant="primary"
                className={mobile ? 'min-h-11 min-w-11' : ''}
                data-testid="create-space-kb-button"
                onClick={() => onCreateKbInSpace('notebook')}
              >
                {t('document.navigation.createInSpace')}
              </Button>
            )}
            {onCreateKb && (
              <Button
                variant="primary"
                size="sm"
                className={mobile ? 'min-h-11 min-w-11' : ''}
                onClick={() => onCreateKb('notebook')}
                data-testid="create-kb-button"
              >
                <Plus className="w-4 h-4 mr-1" />
                {t('document.knowledgeBase.create', '新建知识库')}
              </Button>
            )}
          </div>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <Input
            data-testid="knowledge-search"
            aria-label={t('document.navigation.search')}
            placeholder={t('document.navigation.search')}
            value={search}
            onChange={event => setSearch(event.target.value)}
            className={
              mobile
                ? groupId === 'organization'
                  ? 'min-h-11 min-w-0 flex-1'
                  : 'min-h-11 w-full'
                : 'h-9 w-48'
            }
          />
          {supportsSpaceFilter && onFilterGroupChange && (
            <div className={mobile ? 'min-w-0 flex-1' : undefined}>
              <KnowledgeLibraryFilter
                groups={filterGroups}
                personalCount={
                  candidateKbs.filter(kb => matchesSpaceFilter(kb, PERSONAL_SPACE_FILTER)).length
                }
                companyCount={
                  showCompanySpace
                    ? candidateKbs.filter(kb => matchesSpaceFilter(kb, COMPANY_SPACE_FILTER)).length
                    : undefined
                }
                value={spaceFilter ?? null}
                onValueChange={onFilterGroupChange}
                mobile={mobile}
              />
            </div>
          )}
          {mobile ? (
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className="min-h-11 min-w-11 w-auto shrink-0 px-2"
                  aria-label={t('document.navigation.typeAndSort')}
                  title={t('document.navigation.typeAndSort')}
                  data-testid="knowledge-mobile-filters"
                >
                  <SlidersHorizontal className="h-4 w-4" />
                  {category !== 'all' && (
                    <span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary">
                      {t(`document.knowledgeBase.categoryFilter.${category}`)}
                    </span>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                collisionPadding={8}
                aria-label={t('document.navigation.typeAndSort')}
                className="max-h-[var(--radix-popover-content-available-height)] w-80 max-w-[calc(100vw_-_2rem)] overflow-y-auto"
              >
                <div className="space-y-4">{renderFilterControls()}</div>
              </PopoverContent>
            </Popover>
          ) : (
            renderFilterControls()
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto min-w-0">
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Spinner />
          </div>
        ) : isPersonalMode ? (
          // Personal mode: show separate sections for created and shared
          renderPersonalModeContent()
        ) : isGroupSectionMode ? (
          // Group section mode: show native and shared sub-sections
          renderGroupSectionContent()
        ) : filteredKbs.length === 0 ? (
          renderEmptyState()
        ) : mobile ? (
          <KnowledgeMobileList
            items={filteredKbs}
            onSelect={onSelectKb}
            getSpace={getKbGroupInfo}
            renderActions={kb => (
              <KnowledgeBaseActions
                mobile
                kbId={kb.id}
                onPermissions={onViewPermissions ? () => onViewPermissions(kb) : undefined}
                onMigrate={onMigrateKb && canMigrate?.(kb) ? () => onMigrateKb(kb) : undefined}
                onEdit={onEditKb && canManageKb?.(kb) ? () => onEditKb(kb) : undefined}
                onDelete={onDeleteKb && canManageKb?.(kb) ? () => onDeleteKb(kb) : undefined}
              />
            )}
          />
        ) : (
          <Table className="w-full min-w-[720px] table-fixed">
            {renderTableHeader(isAllMode, showFromColumn)}
            {renderTableRows(filteredKbs, isAllMode, showFromColumn)}
          </Table>
        )}
      </div>
    </div>
  )
}

// Knowledge base table row component
interface KnowledgeBaseRowProps {
  kb: KbDataItem
  onClick: () => void
  onPermissions?: () => void
  onEdit?: () => void
  onDelete?: () => void
  onMigrate?: () => void
  onToggleFavorite?: (e: React.MouseEvent) => void
  isFavorite?: boolean
  showPermissionInfo?: boolean
  showGroupInfo?: boolean
  showFromInfo?: boolean
  groupInfo?: KbGroupInfo
  canMigrate?: boolean
}

function KnowledgeBaseRow({
  onPermissions,
  kb,
  onClick,
  onEdit,
  onDelete,
  onMigrate,
  onToggleFavorite: _onToggleFavorite,
  isFavorite,
  showPermissionInfo,
  showGroupInfo,
  showFromInfo,
  groupInfo,
  canMigrate,
}: KnowledgeBaseRowProps) {
  const { t, i18n } = useTranslation('knowledge')
  return (
    <TableRow
      className="border-b border-border hover:bg-surface-hover cursor-pointer transition-colors"
      onClick={onClick}
      data-testid={`kb-row-${kb.id}`}
    >
      {/* Name column */}
      <TableCell className="px-4 py-2 overflow-hidden">
        <div className="flex items-center gap-3 min-w-0">
          <KnowledgeBaseIcon kbType={kb.kb_type} className="w-5 h-5 flex-shrink-0" />
          <span className="text-sm font-medium text-text-primary truncate" title={kb.name}>
            {kb.name}
          </span>
          {isFavorite && <Star className="w-4 h-4 text-yellow-500 fill-yellow-500 flex-shrink-0" />}
        </div>
      </TableCell>

      {/* Group column - only in "All" mode */}
      {showGroupInfo && (
        <TableCell className="px-4 py-2 text-text-secondary overflow-hidden">
          <span className="truncate block">{groupInfo ? groupInfo.groupName : '--'}</span>
        </TableCell>
      )}

      {/* From column - shows who shared the KB */}
      {showFromInfo && (
        <TableCell className="px-4 py-2 text-text-secondary overflow-hidden">
          <span className="truncate block">
            {'group_type' in kb ? getKbShareSourceText(kb as KnowledgeBaseWithGroupInfo) : '--'}
          </span>
        </TableCell>
      )}

      {showPermissionInfo && (
        <TableCell className="px-3 py-2 text-text-secondary whitespace-nowrap">
          {getListedPermission(kb)
            ? t(`document.permission.role.${getListedPermission(kb)}`)
            : null}
        </TableCell>
      )}

      {/* Created at column */}
      <TableCell className="px-3 py-2 text-text-secondary whitespace-nowrap">
        {formatDateTime(kb.created_at, i18n.language)}
      </TableCell>

      {/* Updated at column */}
      <TableCell className="hidden px-3 py-2 text-text-secondary whitespace-nowrap xl:table-cell">
        {formatDateTime(kb.updated_at, i18n.language)}
      </TableCell>

      {/* Actions column - Migrate, Edit and Delete */}
      <TableCell className="px-2 py-2">
        <KnowledgeBaseActions
          kbId={kb.id}
          onPermissions={onPermissions}
          onMigrate={canMigrate ? onMigrate : undefined}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      </TableCell>
    </TableRow>
  )
}

export default KnowledgeGroupListPage
