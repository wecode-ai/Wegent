import { useState } from 'react'
import { ChevronDown, ChevronRight, GitBranch, Plus } from 'lucide-react'
import type { CollaborationIssue } from '../types'
import type { CollaborationTranslate } from '../i18n'

export function IssueHierarchySummary({
  item,
  allItems,
  onOpen,
  onAddChild,
  translate: t,
}: {
  item: CollaborationIssue
  allItems: readonly CollaborationIssue[]
  onOpen(item: CollaborationIssue): void
  onAddChild?: () => void
  translate: CollaborationTranslate
}) {
  const [expanded, setExpanded] = useState(true)
  const related = allItems.filter(
    candidate =>
      candidate.can_view_detail !== false && candidate.cloud_project_id === item.cloud_project_id
  )
  const parent = related.find(candidate => candidate.id === item.parent_id)
  const children = related.filter(candidate => candidate.parent_id === item.id)
  const completed = children.filter(child => child.status === 'completed').length
  if (!parent && children.length === 0 && !onAddChild) return null
  return (
    <section data-testid="issue-hierarchy-summary" className="mb-4 space-y-2">
      {parent ? (
        <button
          type="button"
          data-testid="issue-parent-link"
          onClick={() => onOpen(parent)}
          title={`${parent.id} · ${parent.title}`}
          className="flex max-w-full items-center gap-1.5 rounded-lg px-1 py-1 text-left text-xs text-text-secondary hover:bg-muted max-md:min-h-11"
        >
          <GitBranch className="h-3.5 w-3.5 shrink-0" />
          <span className="shrink-0">{t('todo.parent_board_parent')}</span>
          <span className="truncate">{parent.title}</span>
          <span className="shrink-0 text-text-muted">{parent.id}</span>
        </button>
      ) : null}
      {children.length || onAddChild ? (
        <div className="rounded-xl border border-border px-3 py-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="issue-children-toggle"
              aria-expanded={expanded}
              onClick={() => setExpanded(value => !value)}
              className="flex min-w-0 items-center gap-1 rounded-md py-1 text-xs text-text-secondary hover:bg-muted max-md:min-h-11"
            >
              {expanded ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
              {t('todo.parent_board_children')}
              <span data-testid="issue-children-progress" className="ml-1 text-text-muted">
                {t('todo.parent_board_progress', undefined, {
                  completed,
                  total: children.length,
                })}
              </span>
            </button>
            {onAddChild ? (
              <button
                type="button"
                data-testid="issue-hierarchy-add-child"
                onClick={onAddChild}
                className="ml-auto flex h-7 items-center gap-1 rounded-md px-2 text-xs text-text-secondary hover:bg-muted max-md:h-11"
              >
                <Plus className="h-3.5 w-3.5" />
                {t('todo.parent_board_add_child')}
              </button>
            ) : null}
          </div>
          {expanded ? (
            <div
              data-testid="issue-hierarchy-children-list"
              className="max-h-56 overflow-y-auto overscroll-y-contain"
            >
              {children.map(child => (
                <button
                  key={child.id}
                  type="button"
                  data-testid={`issue-hierarchy-child-${child.id}`}
                  onClick={() => onOpen(child)}
                  title={child.title}
                  className="flex min-h-9 w-full items-center gap-2 border-t border-border py-2 text-left text-sm hover:text-focus max-md:min-h-11"
                >
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${child.status === 'completed' ? 'bg-green-600' : child.status === 'in_progress' ? 'bg-text-primary' : 'bg-text-muted/40'}`}
                  />
                  <span className="min-w-0 flex-1 truncate">{child.title}</span>
                  <span className="max-w-24 truncate text-xs text-text-muted">
                    {child.assignee_agent_name ?? child.assignee_team_name ?? child.assignee_name}
                  </span>
                  <span className="shrink-0 text-xs text-text-muted">
                    {t(`todo.status_${child.status}`, child.status)}
                  </span>
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
