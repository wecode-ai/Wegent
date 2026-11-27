import { RotateCw, Undo2 } from 'lucide-react'
import type { SearchableSelectOption } from '../controls/SearchableSelect'
import type { CollaborationTranslate } from '../i18n'
import type { CollaborationIssue } from '../types'
import { issueAssigneeTarget, type IssueAssigneeTarget } from './IssueDetailDraft'

export type IssueAssignmentShortcut = {
  kind: 'redeliver' | 'return' | 'recent'
  value:
    | `redeliver:${IssueAssigneeTarget}`
    | `return:${IssueAssigneeTarget}`
    | `recent:${IssueAssigneeTarget}`
  target: IssueAssigneeTarget
  currentTarget?: IssueAssigneeTarget
  historyIndex?: number
  label: string
}

type IssueAssignmentSnapshot = Pick<
  CollaborationIssue,
  | 'assignee_user_id'
  | 'assignee_group_id'
  | 'assignee_agent_id'
  | 'assignee_team_id'
  | 'assignment_history'
>

export function commentAssigneeValue(target: IssueAssigneeTarget): string {
  return target.startsWith('user:') ? target.slice(5) : target
}

export function previousIssueAssignment(
  issue: IssueAssignmentSnapshot
): { target: IssueAssigneeTarget; historyIndex: number } | null {
  const current = issueAssigneeTarget(issue)
  const history = issue.assignment_history ?? []
  for (let index = history.length - 1; index >= 0; index--) {
    const entry = history[index]
    if (!entry.to_type || !entry.to_id) continue
    const target = `${entry.to_type}:${entry.to_id}` as IssueAssigneeTarget
    if (target !== current) return { target, historyIndex: index }
  }
  return null
}

export function isValidIssueAssignmentShortcut(
  issue: IssueAssignmentSnapshot,
  shortcut: Pick<IssueAssignmentShortcut, 'kind' | 'target' | 'currentTarget' | 'historyIndex'>
): boolean {
  const current = issueAssigneeTarget(issue)
  if (shortcut.kind === 'redeliver') {
    return Boolean(shortcut.target) && current === shortcut.target
  }
  if (shortcut.kind === 'return') {
    const previous = previousIssueAssignment(issue)
    return (
      Boolean(shortcut.target) &&
      current !== shortcut.target &&
      (shortcut.currentTarget === undefined || current === shortcut.currentTarget) &&
      previous?.target === shortcut.target &&
      (shortcut.historyIndex === undefined || previous.historyIndex === shortcut.historyIndex)
    )
  }
  return false
}

export function issueAssignmentOptions<T extends string>(
  shortcuts: IssueAssignmentShortcut[],
  candidates: SearchableSelectOption<T>[],
  testIdPrefix: string,
  translate: CollaborationTranslate
): SearchableSelectOption<T | IssueAssignmentShortcut['value']>[] {
  if (!shortcuts.length) return candidates
  const byValue = new Map<string, SearchableSelectOption<T>>(
    candidates.map(candidate => [candidate.value, candidate])
  )
  const moved = new Set<string>()
  const grouped: SearchableSelectOption<T | IssueAssignmentShortcut['value']>[] = []
  for (const shortcut of shortcuts) {
    if (shortcut.kind === 'recent') {
      const candidate =
        byValue.get(shortcut.target) ?? byValue.get(commentAssigneeValue(shortcut.target))
      if (candidate) {
        moved.add(candidate.value)
        grouped.push({
          ...candidate,
          group: undefined,
          section: translate('todo.assignment_recent_transfers', '最近转派'),
        })
      }
      continue
    }
    const Icon = shortcut.kind === 'redeliver' ? RotateCw : Undo2
    grouped.push({
      value: shortcut.value,
      label: shortcut.label,
      section: translate('todo.assignment_shortcuts', '快捷操作'),
      icon: <Icon aria-hidden="true" size={16} className="shrink-0" />,
      testId: `${testIdPrefix}-${shortcut.kind}`,
    })
  }
  return [...grouped, ...candidates.filter(candidate => !moved.has(candidate.value))]
}

export function issueAssignmentShortcuts(
  issue: CollaborationIssue,
  candidates: SearchableSelectOption<IssueAssigneeTarget>[],
  currentName: string | null,
  canRedeliver: boolean,
  translate: CollaborationTranslate
): IssueAssignmentShortcut[] {
  const current = issueAssigneeTarget(issue)
  const shortcuts: IssueAssignmentShortcut[] = []
  if (canRedeliver && current.startsWith('user:') && currentName) {
    shortcuts.push({
      kind: 'redeliver',
      value: `redeliver:${current}`,
      target: current,
      currentTarget: current,
      label: translate('todo.redeliver_to_assignee', '重新投递给 {{name}}', { name: currentName }),
    })
  }
  const history = issue.assignment_history ?? []
  const byTarget = new Map<string, SearchableSelectOption<IssueAssigneeTarget>>(
    candidates.map(candidate => [candidate.value, candidate])
  )
  const seen = new Set<string>([current])
  let previousFound = false
  let recentCount = 0
  for (let index = history.length - 1; index >= 0; index--) {
    const entry = history[index]
    if (!entry.to_type || !entry.to_id) continue
    const target = `${entry.to_type}:${entry.to_id}`
    if (seen.has(target)) continue
    seen.add(target)
    const candidate = byTarget.get(target)
    if (!previousFound) {
      // The most recent distinct assignee is the previous assignee, even if unavailable now.
      previousFound = true
      if (candidate && !candidate.disabled) {
        shortcuts.push({
          kind: 'return',
          value: `return:${candidate.value}`,
          target: candidate.value,
          currentTarget: current,
          historyIndex: index,
          label: translate('todo.return_to_assignee', '转回给 {{name}}', { name: candidate.label }),
        })
      }
      continue
    }
    if (entry.to_type === 'user' && candidate && !candidate.disabled) {
      shortcuts.push({
        kind: 'recent',
        value: `recent:${candidate.value}`,
        target: candidate.value,
        label: candidate.label,
      })
      if (++recentCount === 3) break
    }
  }
  return shortcuts
}
