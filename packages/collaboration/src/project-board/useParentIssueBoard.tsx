import { useState } from 'react'
import { GitBranch } from 'lucide-react'
import { projectBoardParentRows, type ParentBoardItem } from './parentBoardGrouping'
import type { ProjectBoardColumn, ProjectBoardStatePort } from './ProjectBoardBody'
import type { CollaborationTranslate } from '../i18n'
import { Tooltip } from '../issue-detail/Tooltip'

function readPreference(key: string): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(key) === 'true'
  } catch {
    return false
  }
}

function savePreference(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, String(value))
  } catch {
    // Personal layout remains usable when the host cannot persist preferences.
  }
}

export function useParentIssueBoard<T extends ParentBoardItem>({
  scope,
  enabled,
  items,
  columns,
  currentParentId,
  state,
  getColumnItems,
  translate: t,
}: {
  scope: string
  enabled: boolean
  items: T[]
  columns: readonly ProjectBoardColumn[]
  currentParentId: string | null
  state: ProjectBoardStatePort
  getColumnItems(
    column: ProjectBoardColumn,
    state: ProjectBoardStatePort,
    parentId?: string | null
  ): readonly T[]
  translate: CollaborationTranslate
}) {
  const [preference, setPreference] = useState<{
    scope: string
    value: boolean
  } | null>(null)
  const storageKey = `collaboration-board-parent-rows:v1:${scope}`
  const active =
    enabled && (preference?.scope === scope ? preference.value : readPreference(storageKey))
  return {
    scopeKey: `${scope}:${currentParentId ?? 'root'}`,
    active,
    rows: active
      ? projectBoardParentRows({
          items,
          columns,
          currentParentId,
          getColumnItems: (column, parentId) => {
            const parent = items.find(
              item => item.id === parentId && item.can_view_detail !== false
            )
            const query = state.query.trim().toLocaleLowerCase()
            const parentMatches = query && parent?.title.toLocaleLowerCase().includes(query)
            return getColumnItems(column, parentMatches ? { ...state, query: '' } : state, parentId)
          },
        })
      : [],
    toggle: enabled ? (
      <Tooltip label={t('todo.parent_board_layout_hint')} side="bottom">
        <button
          type="button"
          data-testid="cloud-board-parent-layout"
          aria-pressed={active}
          aria-label={t('todo.parent_board_layout')}
          onClick={() => {
            savePreference(storageKey, !active)
            setPreference({ scope, value: !active })
          }}
          className={`project-board-compact-action inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border px-3 text-xs transition max-md:h-11 ${
            active
              ? 'border-text-primary/20 bg-text-primary text-background hover:bg-text-primary/90'
              : 'border-border bg-background text-text-secondary hover:bg-muted'
          }`}
        >
          <GitBranch className="h-3.5 w-3.5" />
          <span className="project-board-action-label">{t('todo.parent_board_layout')}</span>
        </button>
      </Tooltip>
    ) : null,
  }
}
