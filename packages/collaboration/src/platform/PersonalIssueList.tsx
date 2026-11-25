import type { CollaborationProject } from '../types'
import type { WorkspaceMyWorkItem, WorkspaceTaskBinding } from '../ports/SharedWorkspaceApi'
import { composerMarkdownText } from '../composer'
import { resolveIssueCardAssignee } from '../issue-card/model'
import { ProjectIssueTable } from './ProjectIssueTable'
import { Button as ControlButton } from '../markdown/Button'
import { Bell, FolderOpen } from 'lucide-react'
import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { useClock } from '../clock'
import { personalHomeAssignmentAt, personalHomeAssignmentDuration } from './personalHomeAssignment'
import type { PersonalHomeIssueOrder, usePersonalHomeIssues } from './usePersonalHomeIssues'
import { issueNeedsUser, pendingIssueHumanRequests } from '../issueParticipation'

type IssueActivityProps = {
  summary: ReactNode
  assignment: WorkspaceMyWorkItem['assignment_context']
  bindings: WorkspaceMyWorkItem['task_bindings']
  onOpenTask?(binding: WorkspaceTaskBinding): void
  issueId: string
  active: boolean
}

export function PersonalIssueList({
  userId,
  localUserIds,
  state,
  unassignedUserId,
  showUnassignedEmpty,
  projects,
  showCompleted,
  assignedOnly,
  onOpenIssue,
  onOpenProject,
  selectedIssue,
  active,
  onOpenTask,
  recentIssue,
  hideEmpty = false,
  emptyState,
  order,
  language,
  translate: t,
  renderActivity,
}: {
  userId: number
  localUserIds?: readonly (string | number)[]
  active: boolean
  onOpenTask?(issue: WorkspaceMyWorkItem, binding: WorkspaceTaskBinding): void
  hideEmpty?: boolean
  emptyState?: ReactNode
  recentIssue?: WorkspaceMyWorkItem
  order: PersonalHomeIssueOrder
  state: ReturnType<typeof usePersonalHomeIssues>
  unassignedUserId?: number
  showUnassignedEmpty?: boolean
  projects: CollaborationProject[]
  showCompleted: boolean
  assignedOnly: boolean
  onOpenIssue(issue: WorkspaceMyWorkItem): void
  onOpenProject?(project: CollaborationProject): void
  selectedIssue?: Pick<WorkspaceMyWorkItem, 'id' | 'cloud_project_id'>
  language: string
  translate(key: string, options?: Record<string, string | number>): string
  renderActivity?(props: IssueActivityProps): ReactNode
}) {
  const nowMs = useClock(active, { resolutionMs: 60_000 })
  const recentCard = useRef<HTMLTableRowElement>(null)
  const revealedIssue = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (!recentIssue || !recentCard.current || revealedIssue.current === recentIssue.id) return
    revealedIssue.current = recentIssue.id
    recentCard.current.scrollIntoView?.({ block: 'nearest' })
    recentCard.current.animate?.(
      [
        { backgroundColor: 'color-mix(in srgb, currentColor 8%, transparent)' },
        { backgroundColor: 'transparent' },
      ],
      { duration: 1600 }
    )
  }, [recentIssue])
  const items = state.items
  const visibleItems = recentIssue
    ? [
        items.find(
          item =>
            item.id === recentIssue.id && item.cloud_project_id === recentIssue.cloud_project_id
        ) ?? recentIssue,
        ...items.filter(
          item =>
            item.id !== recentIssue.id || item.cloud_project_id !== recentIssue.cloud_project_id
        ),
      ]
    : items
  const compareItems = (left: WorkspaceMyWorkItem, right: WorkspaceMyWorkItem) => {
    if (left.id === right.id && left.cloud_project_id === right.cloud_project_id) return 0
    if (left.id === recentIssue?.id) return -1
    if (right.id === recentIssue?.id) return 1
    const a = left.attention_order
    const b = right.attention_order
    return (
      (a?.[0] ?? 3) - (b?.[0] ?? 3) ||
      (a?.[1] ?? 4) - (b?.[1] ?? 4) ||
      ((Date.parse(b?.[2] ?? right.updated_at) || 0) -
        (Date.parse(a?.[2] ?? left.updated_at) || 0)) *
        (order === 'assignment' ? -1 : 1) ||
      right.id.localeCompare(left.id)
    )
  }
  const orderedItems = visibleItems.filter(item => item.cloud_project_id).sort(compareItems)
  const itemsByProject = new Map<string, WorkspaceMyWorkItem[]>()
  for (const item of orderedItems) {
    const key = String(item.cloud_project_id)
    const items = itemsByProject.get(key) ?? []
    items.push(item)
    itemsByProject.set(key, items)
  }
  const groups: Array<{ project: CollaborationProject | null; items: WorkspaceMyWorkItem[] }> =
    projects
      .map(project => ({
        project,
        items: (itemsByProject.get(String(project.id)) ?? []).filter(
          item =>
            String(item.cloud_project_id) === String(project.id) &&
            (!assignedOnly ||
              (item.assignee_user_id != null &&
                (project.project_store === 'local'
                  ? (localUserIds ?? [userId])
                  : [project.current_user_id ?? userId]
                ).some(id => String(item.assignee_user_id) === String(id)))) &&
            !item.archived_at &&
            (showCompleted || !['completed', 'cancelled'].includes(item.status))
        ),
      }))
      .filter(group => group.items.length)
      .sort(
        (left, right) =>
          Number(right.project.id === recentIssue?.cloud_project_id) -
            Number(left.project.id === recentIssue?.cloud_project_id) ||
          (order === 'attention'
            ? Number(right.items.some(item => item.attention_order?.[0] === 0)) -
              Number(left.items.some(item => item.attention_order?.[0] === 0))
            : compareItems(left.items[0], right.items[0]))
      )
  const unassignedItems = visibleItems.filter(item => !item.cloud_project_id)
  if (showUnassignedEmpty || unassignedItems.length)
    groups.unshift({ project: null, items: unassignedItems })
  return (
    <>
      {!hideEmpty &&
        !state.loading &&
        !state.error &&
        !groups.length &&
        (emptyState ?? (
          <p className="py-8 text-sm text-text-secondary">{t('personalHome.empty')}</p>
        ))}
      {groups.map(({ project, items }) => (
        <section
          key={project?.id ?? 'unassigned'}
          className="mb-4"
          data-testid={project ? `personal-home-project-${project.id}` : 'independent-issue-list'}
        >
          <h3 className="mb-1 flex items-center gap-2 text-base font-medium text-text-secondary">
            <FolderOpen aria-hidden="true" className="h-4 w-4 text-text-muted" />
            {project && onOpenProject ? (
              <ControlButton
                variant="unstyled"
                type="button"
                data-testid={`personal-issues-project-${project.id}`}
                className="min-h-11 min-w-11 truncate text-left hover:underline md:min-h-0 md:min-w-0"
                onClick={() => onOpenProject(project)}
              >
                {project.name}
              </ControlButton>
            ) : (
              (project?.name ?? t('independentIssues.independent'))
            )}
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs font-normal text-text-secondary">
              {items.length}
            </span>
          </h3>
          {!items.length && !state.loading && !state.error ? (
            <p className="py-3 text-sm text-text-secondary">{t('personalHome.empty')}</p>
          ) : null}
          {!!items.length && (
            <ProjectIssueTable
              issues={items}
              emptyLabel={t('personalHome.empty')}
              issueLabel={t('todo.issue_column')}
              statusLabel={t('todo.status')}
              assignmentsLabel={t('todo.assignee')}
              tagLabel={t('todo.tags')}
              startAtLabel={t('todo.start_date')}
              dueAtLabel={t('todo.end_date')}
              updatedLabel={t('todo.updated_at')}
              showIssueKey={Boolean(project)}
              selectable={false}
              showControls={false}
              statusName={status =>
                project?.board_config?.statuses.find(candidate => candidate.id === status)?.name ??
                t(`todo.status_${status}`, { defaultValue: status })
              }
              onOpen={onOpenIssue}
              getRowOptions={item => {
                const viewerIds =
                  project?.project_store === 'local'
                    ? (localUserIds ?? [userId])
                    : [project ? (project.current_user_id ?? userId) : (unassignedUserId ?? userId)]
                const assignedAt = personalHomeAssignmentAt(item, viewerIds)
                const waiting =
                  pendingIssueHumanRequests(item).length > 0 && issueNeedsUser(item, viewerIds)
                const text = composerMarkdownText(item.description)
                const title = item.title.trim().replace(/\s+/g, ' ')
                const following = text.charAt(title.length)
                const summaryText =
                  !title.endsWith('…') &&
                  text.startsWith(title) &&
                  (!following || /\s/.test(following))
                    ? text.slice(title.length).trim()
                    : text
                const summary = summaryText && (
                  <p className="line-clamp-1 whitespace-pre-wrap text-text-secondary">
                    {summaryText}
                  </p>
                )
                return {
                  buttonTestId: `${project ? 'personal-home-issue' : 'independent-issue'}-${item.id}`,
                  assigneeName:
                    resolveIssueCardAssignee(item).assigneeName ??
                    (item.assignee_user_id != null &&
                    viewerIds.some(id => String(id) === String(item.assignee_user_id))
                      ? t('personalHome.me')
                      : null),
                  active:
                    selectedIssue?.id === item.id &&
                    selectedIssue.cloud_project_id === item.cloud_project_id,
                  ref:
                    item.id === recentIssue?.id
                      ? row => {
                          recentCard.current = row
                        }
                      : undefined,
                  titleTrailing: (
                    <>
                      {waiting && (
                        <span className="inline-flex items-center gap-1 text-xs text-text-secondary">
                          <Bell aria-hidden="true" className="h-3.5 w-3.5" />
                          {t('personalHome.needsInput')}
                        </span>
                      )}
                      {assignedAt && (
                        <time
                          dateTime={assignedAt}
                          data-testid={`personal-home-assignment-age-${item.id}`}
                          title={new Date(assignedAt).toLocaleString(language)}
                          className="block text-xs text-text-secondary"
                        >
                          {t('personalHome.assignedFor', {
                            duration: personalHomeAssignmentDuration(assignedAt, language, nowMs),
                          })}
                        </time>
                      )}
                    </>
                  ),
                  details:
                    renderActivity?.({
                      summary,
                      assignment: item.assignment_context,
                      bindings: item.task_bindings,
                      onOpenTask: onOpenTask && (binding => onOpenTask(item, binding)),
                      issueId: item.id,
                      active,
                    }) ?? summary,
                }
              }}
            />
          )}
        </section>
      ))}
    </>
  )
}
