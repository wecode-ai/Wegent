// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { CollaborationProject, CollaborationStatus } from '../types'
import type { ProjectBoardColumn } from './ProjectBoardBody'
import type { ProjectBoardSort } from './projectBoardSorting'
import type { CollaborationTranslate } from '../i18n'
import { hasTooManyTags } from '../tagging'

export interface SavedBoardColumn {
  id: string
  type: 'status' | 'tag' | 'unmatched'
  value: string
  [key: string]: unknown
}

export interface SavedBoardView {
  id: string
  name: string
  columns: SavedBoardColumn[]
  filter?: { tags?: string[]; match?: 'any' | 'all'; [key: string]: unknown }
  sorts?: Record<string, ProjectBoardSort>
  [key: string]: unknown
}

export interface ProjectBoardViews {
  schema_version: number
  default_view_id?: string
  views: SavedBoardView[]
  [key: string]: unknown
}

export interface BoardViewSaveSettings {
  isDefault: boolean
  cardDisplay?: CollaborationProject['card_display']
  boardConfig?: CollaborationProject['board_config']
}

export function defaultBoardViewId(config?: ProjectBoardViews | null): string {
  return config?.schema_version === 1 &&
    config.views.some(view => view.id === config.default_view_id)
    ? config.default_view_id!
    : 'default'
}

export function matchesBoardView(
  item: { tags: string[] },
  view?: Pick<SavedBoardView, 'filter'> | null
) {
  const tags = view?.filter?.tags ?? []
  if (!tags.length) return true
  return view?.filter?.match === 'any'
    ? tags.some(tag => item.tags.includes(tag))
    : tags.every(tag => item.tags.includes(tag))
}

export function savedBoardColumns(
  view: SavedBoardView,
  statuses: readonly CollaborationStatus[],
  statusColumns: readonly ProjectBoardColumn[]
): ProjectBoardColumn[] {
  const columns: ProjectBoardColumn[] = view.columns.map(column => ({
    key: column.id,
    type: column.type,
    groupValue: column.value,
    label:
      column.type !== 'status'
        ? column.value
        : (statuses.find(status => status.id === column.value)?.name ?? column.value),
    dotClass:
      column.type === 'status'
        ? (statusColumns.find(status => status.groupValue === column.value)?.dotClass ??
          'bg-zinc-400')
        : 'bg-zinc-400',
    status: column.type === 'status' ? column.value : '',
  }))
  const matchedColumns = columns.filter(column => column.type !== 'unmatched')
  return columns.map(column =>
    column.type === 'unmatched'
      ? { ...column, unmatchedColumns: matchedColumns, unmatchedFilter: view.filter }
      : column
  )
}

export function createSavedBoardView(statuses: readonly CollaborationStatus[]): SavedBoardView {
  return {
    id: crypto.randomUUID(),
    name: '',
    columns: statuses.map(status => ({
      id: crypto.randomUUID(),
      type: 'status',
      value: status.id,
    })),
    filter: { tags: [], match: 'all' },
  }
}

export function unmatchedCreateDefaults(
  view: SavedBoardView,
  statuses: readonly CollaborationStatus[]
) {
  const statusValues = new Set(
    view.columns.filter(column => column.type === 'status').map(column => column.value)
  )
  const tagValues = new Set(
    view.columns.filter(column => column.type === 'tag').map(column => column.value)
  )
  const status = statuses[0]?.id
  const filterTags = view.filter?.tags ?? []
  const tags =
    view.filter?.match === 'any'
      ? filterTags.filter(tag => !tagValues.has(tag)).slice(0, 1)
      : filterTags
  if (
    !status ||
    statusValues.has(status) ||
    hasTooManyTags(tags) ||
    tags.some(tag => tagValues.has(tag)) ||
    (filterTags.length > 0 && tags.length === 0)
  )
    return null
  return { status, tags, draftScope: `board-view:${view.id}:unmatched` }
}

export function boardDropHint(
  item: { status: string; tags: string[] },
  target: ProjectBoardColumn,
  source: ProjectBoardColumn | undefined,
  groupBy: string,
  t: CollaborationTranslate
) {
  const type = target.type ?? groupBy
  if (type === 'unmatched') {
    const stageTags = new Set(
      target.unmatchedColumns
        ?.filter(column => column.type === 'tag')
        .map(column => column.groupValue)
    )
    if (
      !matchesBoardView(
        { tags: item.tags.filter(tag => !stageTags.has(tag)) },
        { filter: target.unmatchedFilter }
      )
    )
      return t('todo.board_drop_unmatched_filter')
    return t(
      target.unmatchedColumns?.some(
        column => column.type === 'status' && column.groupValue === item.status
      )
        ? 'todo.board_drop_unmatched_status'
        : 'todo.board_drop_unmatched'
    )
  }
  if (type === 'status')
    return item.status === target.groupValue
      ? t('todo.board_drop_has_status')
      : t('todo.board_drop_status', undefined, { status: target.label })
  if (type !== 'tag') return target.label
  if (!target.groupValue) return t('todo.board_drop_clear_tags')
  const removing =
    (source?.type ?? groupBy) === 'tag' &&
    source?.groupValue &&
    source.key !== target.key &&
    item.tags.includes(source.groupValue)
  if (removing)
    return t('todo.board_drop_move_tag', undefined, {
      source: source.label,
      tag: target.label,
    })
  return item.tags.includes(target.groupValue)
    ? t('todo.board_drop_has_tag')
    : t('todo.board_drop_add_tag', undefined, { tag: target.label })
}
