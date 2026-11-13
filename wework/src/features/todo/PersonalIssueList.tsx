import { useLayoutEffect, useRef } from 'react'
import { Bell, FolderOpen } from 'lucide-react'
import type {
  CollaborationProject,
  WorkspaceMyWorkItem,
  WorkspaceTaskBinding,
} from '@wegent/collaboration'
import {
  CollaborationIssueCard,
  createCollaborationTranslator,
  createIssueBoardCardLabels,
  issueNeedsUser,
  pendingIssueHumanRequests,
} from '@wegent/collaboration'
import { useTranslation } from '@/hooks/useTranslation'
import { useSidebarRelativeTimeRefresh } from '@/components/layout/runtimeSidebarTime'
import { PersonalHomeIssueActivity } from './PersonalHomeIssueActivity'
import { personalHomeAssignmentAt, personalHomeAssignmentDuration } from './personalHomeAssignment'
import type { usePersonalHomeIssues, PersonalHomeIssueOrder } from './usePersonalHomeIssues'

export function PersonalIssueList({
  userId,
  localUserIds,
  state,
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
  order,
}: {
  userId: number
  localUserIds?: readonly (string | number)[]
  active: boolean
  onOpenTask(issue: WorkspaceMyWorkItem, binding: WorkspaceTaskBinding): void
  hideEmpty?: boolean
  recentIssue?: WorkspaceMyWorkItem
  order: PersonalHomeIssueOrder
  state: ReturnType<typeof usePersonalHomeIssues>
  projects: CollaborationProject[]
  showCompleted: boolean
  assignedOnly: boolean
  onOpenIssue(issue: WorkspaceMyWorkItem): void
  onOpenProject?(project: CollaborationProject): void
  selectedIssue?: Pick<WorkspaceMyWorkItem, 'id' | 'cloud_project_id'>
}) {
  const { t, i18n } = useTranslation('common')
  useSidebarRelativeTimeRefresh(active)
  const recentCard = useRef<HTMLElement>(null)
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
  const labels = createIssueBoardCardLabels(
    createCollaborationTranslator(i18n.language.startsWith('zh') ? 'zh-CN' : 'en')
  )
  const visibleItems = recentIssue
    ? [
        state.items.find(
          item =>
            item.id === recentIssue.id && item.cloud_project_id === recentIssue.cloud_project_id
        ) ?? recentIssue,
        ...state.items.filter(
          item =>
            item.id !== recentIssue.id || item.cloud_project_id !== recentIssue.cloud_project_id
        ),
      ]
    : state.items
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
  const orderedItems = [...visibleItems].sort(compareItems)
  const itemsByProject = new Map<string, WorkspaceMyWorkItem[]>()
  for (const item of orderedItems) {
    const key = String(item.cloud_project_id)
    const items = itemsByProject.get(key) ?? []
    items.push(item)
    itemsByProject.set(key, items)
  }
  const groups = projects
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
  return (
    <>
      {state.loading && (
        <p role="status" className="py-4 text-sm text-text-muted">
          {t('personalHome.loading')}
        </p>
      )}
      {!hideEmpty && !state.loading && !state.error && !groups.length && (
        <p className="py-8 text-sm text-text-muted">{t('personalHome.empty')}</p>
      )}
      {groups.map(({ project, items }) => (
        <section
          key={project.id}
          className="mb-4"
          data-testid={`personal-home-project-${project.id}`}
        >
          <h3 className="mb-1 flex items-center gap-2 text-base font-medium text-text-secondary">
            <FolderOpen aria-hidden="true" className="h-4 w-4 text-text-muted" />
            {onOpenProject ? (
              <button
                type="button"
                data-testid={`personal-issues-project-${project.id}`}
                className="truncate text-left hover:underline"
                onClick={() => onOpenProject(project)}
              >
                {project.name}
              </button>
            ) : (
              project.name
            )}
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs font-normal text-text-muted">
              {items.length}
            </span>
          </h3>
          {items.map(item => {
            const viewerIds =
              project.project_store === 'local'
                ? (localUserIds ?? [userId])
                : [project.current_user_id ?? userId]
            const assignedAt = personalHomeAssignmentAt(item, viewerIds)
            const waiting =
              pendingIssueHumanRequests(item).length > 0 && issueNeedsUser(item, viewerIds)
            const currentAssignee =
              item.assignee_user_id != null &&
              viewerIds.some(id => String(id) === String(item.assignee_user_id))
            const configuredStatus = project.board_config?.statuses.find(
              status => status.id === item.status
            )?.name
            const status = waiting
              ? t('personalHome.needsInput')
              : (configuredStatus ?? t(`todo.status_${item.status}`, { defaultValue: item.status }))
            return (
              <CollaborationIssueCard
                variant="list"
                cardRef={item.id === recentIssue?.id ? recentCard : undefined}
                key={item.id}
                item={
                  currentAssignee && !item.assignee_name
                    ? { ...item, assignee_name: t('personalHome.me') }
                    : item
                }
                reference={`#${item.sequence_number}`}
                labels={{
                  ...labels,
                  statuses: {
                    ...labels.statuses,
                    ...Object.fromEntries(
                      (project.board_config?.statuses ?? []).map(status => [status.id, status.name])
                    ),
                  },
                }}
                display={{
                  showAssignee: true,
                  showDate: true,
                  showPriority: true,
                  showTags: true,
                }}
                detailButtonTestId={`personal-home-issue-${item.id}`}
                articleProps={{
                  'aria-current':
                    selectedIssue?.id === item.id &&
                    selectedIssue.cloud_project_id === item.cloud_project_id
                      ? 'true'
                      : undefined,
                }}
                cardClassName="cursor-pointer focus-within:bg-text-primary/[0.025] aria-[current=true]:bg-muted"
                detailButtonClassName="cursor-pointer keyboard:focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/30"
                onOpen={() => onOpenIssue(item)}
                titleTrailing={
                  <>
                    {waiting ? (
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-amber-500/10 px-1.5 py-0.5 text-xs font-normal text-amber-700 dark:text-amber-400">
                        <Bell aria-hidden="true" className="h-3.5 w-3.5" />
                        {status}
                      </span>
                    ) : null}
                    {assignedAt && (
                      <span
                        data-testid={`personal-home-assignment-age-${item.id}`}
                        title={new Date(assignedAt).toLocaleString(i18n.language)}
                        className="shrink-0 text-xs font-normal text-text-muted"
                      >
                        {t('personalHome.assignedFor', {
                          duration: personalHomeAssignmentDuration(assignedAt, i18n.language),
                        })}
                      </span>
                    )}
                  </>
                }
                summary={
                  <>
                    <PersonalHomeIssueActivity
                      summary={
                        <>
                          {item.description ? (
                            <p className="line-clamp-1 max-w-3xl whitespace-pre-wrap text-base leading-6 text-text-secondary">
                              {item.description}
                            </p>
                          ) : undefined}
                        </>
                      }
                      assignment={item.assignment_context}
                      bindings={item.task_bindings}
                      onOpenTask={binding => onOpenTask(item, binding)}
                      issueId={item.id}
                      active={active}
                    />
                  </>
                }
              />
            )
          })}
        </section>
      ))}
    </>
  )
}
