import type { SearchableSelectOption } from '../controls/SearchableSelect'
import type { CollaborationTranslate } from '../i18n'
import type { ProjectBoardColumn } from '../project-board/ProjectBoardBody'
import { defaultBoardViewId, savedBoardColumns } from '../project-board/projectBoardViews'
import { collectProjectTags } from '../project-board/projectTags'
import type { ProjectBoardGroupBy } from '../project-board/useProjectBoardState'
import {
  createStandardCloudBoardColumns,
  matchesStandardCloudBoardColumn,
  resolveStandardCloudBoardGroupMutation,
  standardCloudBoardMutationUpdate,
} from '../project-board/useStandardCloudBoardController'
import { hasTooManyTags } from '../tagging'
import type { CollaborationIssue, CollaborationProject, CollaborationStatus } from '../types'
import type { SharedIssueDetailPort } from './createSharedIssueDetailPort'
import { persistIssueDetailFields } from './persistIssueDetailFields'

export interface IssueCommentBoardContext {
  columns: ProjectBoardColumn[]
  groupBy: ProjectBoardGroupBy
  name: string
  sourceColumnKey?: string
}

export interface CommentIssueActions {
  moves: SearchableSelectOption[]
  assigneeMoves?: string[]
  boardName: string
  currentColumns: string[]
  closed: boolean
  canToggle: boolean
  move(value: string): Promise<void | boolean>
  toggle(closed: boolean): Promise<void>
}

export function defaultIssueCommentBoard(
  project: CollaborationProject,
  items: CollaborationIssue[],
  statuses: CollaborationStatus[],
  t: CollaborationTranslate
): IssueCommentBoardContext {
  const groupBy = project.board_config?.group_by ?? 'status'
  const createColumns = (group: ProjectBoardGroupBy) =>
    createStandardCloudBoardColumns({
      groupBy: group,
      items,
      tags: collectProjectTags(project, items),
      statuses,
      labels: {
        noPriority: t('todo.priority_none'),
        noTag: t('todo.comment_lane_no_tag'),
        unassigned: t('todo.unassigned'),
        priority: Object.fromEntries(
          ['low', 'medium', 'high', 'urgent'].map(id => [id, t(`todo.priority_${id}`)])
        ),
      },
    })
  const view =
    project.board_views?.schema_version === 1
      ? project.board_views.views.find(view => view.id === defaultBoardViewId(project.board_views))
      : undefined
  return {
    groupBy,
    columns:
      project.board_views && project.board_views.schema_version !== 1
        ? []
        : view
          ? savedBoardColumns(view, statuses, createColumns('status'))
          : createColumns(groupBy),
    name: view?.name ?? project.name,
  }
}

/** Use the board's own group mutation so selecting a lane and dragging agree. */
export function createIssueCommentActions({
  issue,
  board,
  statuses,
  editable,
  canAssign,
  issues,
  onUpdated,
  confirmAssignee,
  translate: t,
}: {
  issue: CollaborationIssue
  board: IssueCommentBoardContext
  statuses: CollaborationStatus[]
  editable: boolean
  canAssign: boolean
  issues: SharedIssueDetailPort['issues']
  onUpdated(issue: CollaborationIssue): void
  confirmAssignee(target: string): Promise<boolean>
  translate: CollaborationTranslate
}): CommentIssueActions {
  const matches = board.columns.filter(column =>
    matchesStandardCloudBoardColumn(issue, column, board.groupBy, {})
  )
  const source = matches.find(column => column.key === board.sourceColumnKey)
  const sources = source
    ? [source]
    : matches.length
      ? matches
      : [
          {
            key: 'issue-current-status',
            type: 'status' as const,
            groupValue: issue.status,
            label: issue.status,
            status: issue.status,
            dotClass: '',
          },
        ]
  const operations = new Map<string, { from: ProjectBoardColumn; to: ProjectBoardColumn }>()
  for (const from of sources) {
    for (const to of board.columns) {
      const type = to.type ?? board.groupBy
      if (from.key === to.key || (type === 'assignee' ? !canAssign : !editable)) continue
      const mutation = resolveStandardCloudBoardGroupMutation({
        column: to,
        sourceColumn: from,
        groupBy: board.groupBy,
        item: issue,
        items: [issue],
        extensions: {},
      })
      if (!mutation) continue
      const patch = standardCloudBoardMutationUpdate(mutation)
      if (
        Object.entries(patch).every(
          ([key, value]) =>
            JSON.stringify(issue[key as keyof CollaborationIssue]) === JSON.stringify(value)
        )
      )
        continue
      operations.set(JSON.stringify([from.key, to.key]), { from, to })
    }
  }
  return {
    boardName: board.name,
    currentColumns: matches.map(column => column.label),
    assigneeMoves: [...operations]
      .filter(([, { to }]) => (to.type ?? board.groupBy) === 'assignee')
      .map(([value]) => value),
    moves: [...operations].map(([value, { from, to }]) => ({
      value,
      label: sources.length > 1 ? `${from.label} → ${to.label}` : to.label,
      group: t(`todo.comment_lane_${to.type ?? board.groupBy}`),
    })),
    closed: issue.status === 'completed',
    canToggle:
      editable &&
      statuses.some(status => status.id === 'completed') &&
      statuses.some(status => status.id !== 'completed'),
    async move(value) {
      const operation = operations.get(value)
      if (!operation) throw new Error(t('todo.comment_move_unavailable'))
      const latest = await issues.get(issue.id)
      const { from, to } = operation
      if (!matchesStandardCloudBoardColumn(latest, from, board.groupBy, {}))
        throw new Error(t('todo.comment_move_conflict'))
      const mutation = resolveStandardCloudBoardGroupMutation({
        column: to,
        sourceColumn: from,
        groupBy: board.groupBy,
        item: latest,
        items: [latest],
        extensions: {},
      })
      if (!mutation) throw new Error(t('todo.comment_move_unavailable'))
      if (mutation.kind === 'tag' && hasTooManyTags(mutation.tags))
        throw new Error(t('todo.tag_limit_exceeded'))
      const { priority, ...fields } = standardCloudBoardMutationUpdate(mutation)
      const patch = {
        ...fields,
        ...(priority === undefined ? {} : { priority: priority as CollaborationIssue['priority'] }),
      }
      if (mutation.kind === 'assignee' && mutation.assigneeType && mutation.assigneeId) {
        if (!(await confirmAssignee(`${mutation.assigneeType}:${mutation.assigneeId}`)))
          return false
        const updated = await issues.assign(issue.cloud_project_id, issue.id, {
          version: latest.version,
          assigneeType: mutation.assigneeType,
          assigneeId: mutation.assigneeId,
          notifyAssignee: true,
        })
        onUpdated(updated)
      } else {
        onUpdated(await persistIssueDetailFields(latest, patch, issues))
      }
    },
    async toggle(closed) {
      if (!editable) throw new Error(t('todo.comment_move_unavailable'))
      const latest = await issues.get(issue.id)
      const previous = [...(latest.status_history ?? [])]
        .reverse()
        .find(
          entry =>
            entry.from_status &&
            entry.from_status !== 'completed' &&
            statuses.some(status => status.id === entry.from_status)
        )?.from_status
      const status = closed
        ? 'completed'
        : (previous ?? statuses.find(status => status.id !== 'completed')?.id)
      if (!status || !statuses.some(candidate => candidate.id === status))
        throw new Error(t('todo.comment_move_unavailable'))
      onUpdated(await persistIssueDetailFields(latest, { status }, issues))
    },
  }
}
