import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { useIssuePeopleSearch } from './IssueDetailControls'
import type { TodoEditorProps, CloudLoopItem } from './issueEditorSupport'
import type { CollaborationMember } from '../types'
import type { IssueAssigneeTarget } from './index'

type Person = { id: number; user_name: string }
function createConfirmation() {
  let snapshot: Person | null = null
  let respond: ((approved: boolean) => void) | undefined
  const listeners = new Set<() => void>()
  const resolve = (approved: boolean) => {
    const pending = respond
    respond = undefined
    snapshot = null
    pending?.(approved)
    listeners.forEach(listener => listener())
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        queueMicrotask(() => {
          if (!listeners.size) resolve(false)
        })
      }
    },
    request(user: Person) {
      if (!listeners.size) return Promise.resolve(false)
      resolve(false)
      return new Promise<boolean>(yes => {
        respond = yes
        snapshot = user
        listeners.forEach(listener => listener())
      })
    },
    resolve,
  }
}
export function useIssueOutsideAssignee(
  props: TodoEditorProps,
  item: CloudLoopItem | null,
  projectMembers: CollaborationMember[]
) {
  const project = props.project
  const t = props.translate ?? ((_key: string, fallback = _key) => fallback)
  const searchIssueUsers =
    project?.task_provider && project.task_provider !== 'local'
      ? undefined
      : props.port.members.searchUsers
  const [assigneeQuery, setAssigneeQuery] = useState('')
  const assigneeSearch = useIssuePeopleSearch(assigneeQuery, searchIssueUsers)
  const [selectedOutsideUsers, setSelectedOutsideUsers] = useState<Person[]>([])
  const confirmation = useMemo(createConfirmation, [])
  const outsideAssignee = useSyncExternalStore(
    confirmation.subscribe,
    confirmation.getSnapshot,
    confirmation.getSnapshot
  )
  const outsidePeople = [
    ...new Map(
      [
        ...selectedOutsideUsers,
        ...assigneeSearch.users,
        ...(item?.assignee_user_id != null
          ? [
              {
                id: item.assignee_user_id,
                user_name: item.assignee_name || String(item.assignee_user_id),
              },
            ]
          : []),
      ].map(user => [user.id, user])
    ).values(),
  ]
  const outsideTargetUser = (target: IssueAssigneeTarget) => {
    if (!target.startsWith('user:')) return undefined
    const id = Number(target.slice(5))
    if (projectMembers.some(member => member.user_id === id)) return undefined
    const assigned = props.allItems.find(
      candidate =>
        candidate.cloud_project_id === (project?.id ?? item?.cloud_project_id) &&
        candidate.assignee_user_id === id
    )
    return (
      outsidePeople.find(user => user.id === id) ?? {
        id,
        user_name: assigned?.assignee_name || String(id),
      }
    )
  }
  const confirmOutsideTarget = (target: IssueAssigneeTarget): Promise<boolean> => {
    const user = outsideTargetUser(target)
    return user ? confirmation.request(user) : Promise.resolve(true)
  }
  const resolveOutsideAssignee = useCallback(
    (approved: boolean) => {
      const user = confirmation.getSnapshot()
      if (approved && user)
        setSelectedOutsideUsers(current => [...current.filter(value => value.id !== user.id), user])
      confirmation.resolve(approved)
    },
    [confirmation]
  )
  return {
    searchIssueUsers,
    assigneeQuery,
    setAssigneeQuery,
    assigneeSearch,
    outsideAssignee,
    outsidePeople,
    outsideTargetUser,
    confirmOutsideTarget,
    resolveOutsideAssignee,
    outsideLabel: t(item?.invited_only ? 'todo.issue_person_access' : 'todo.outside_issue_person'),
    confirmPersonLabel: t(
      item?.invited_only ? 'todo.confirm_issue_invitation' : 'todo.confirm_outside_issue_person'
    ),
  }
}
