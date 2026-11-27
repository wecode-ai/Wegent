import {
  detailProjectId,
  unlinkedIssueFromDetail,
  type IndependentIssue,
  type IndependentIssueInput,
  type IssueCreationInput,
  type PersonalIssuesApi,
  type SharedIssueTarget,
} from './personalIssuesApi'
import type { ProjectChatMessage } from '@wegent/chat-core'
import type { SharedIssueDetailUpdateInput } from '../issue-detail/createSharedIssueDetailPort'
import { participantKey } from './issueParticipants'

function sameSelection<T>(current: T[], next: T[]) {
  const currentSelection = new Set(current)
  const nextSelection = new Set(next)
  return (
    currentSelection.size === nextSelection.size &&
    [...nextSelection].every(choice => currentSelection.has(choice))
  )
}

function updateIssueDraft(
  api: PersonalIssuesApi,
  issue: IndependentIssue,
  input: IndependentIssueInput
) {
  const metadata = issue.metadata
  const currentPeople = (metadata.direct_participants ?? metadata.participants).filter(
    participant => participant !== issue.creator_id
  )
  const currentResources = (metadata.resource_participants ?? []).map(participantKey)
  const nextResources = (input.resource_participants ?? []).map(participantKey)
  if (
    !sameSelection(currentPeople, input.participants) ||
    !sameSelection(currentResources, nextResources)
  ) {
    return api.updateWithParticipants(issue.id, { ...input, version: issue.version })
  }

  const fields: Parameters<PersonalIssuesApi['updateDetail']>[1] = { version: issue.version }
  if (issue.title !== input.title) fields.title = input.title
  if (issue.description !== input.description) fields.description = input.description
  if (issue.status !== input.status) fields.status = input.status
  if (issue.priority !== input.priority) fields.priority = input.priority
  if (metadata.due_at !== input.due_at) fields.due_at = input.due_at
  if (metadata.archived !== input.archived) fields.archived = input.archived
  const from = metadata.assignee_resource
  const to = input.assignee_resource
  if (issue.assignee_id !== input.assignee_id || from?.kind !== to?.kind || from?.id !== to?.id) {
    fields.assignee_user_id = input.assignee_id
    if (to?.kind === 'group') fields.assignee_group_id = String(to.id)
    if (to?.kind === 'agent') fields.assignee_agent_id = String(to.id)
  }
  return api.updateDetail(issue.id, fields)
}

interface DialogSnapshot {
  issue: IndependentIssue | null
  comments: ProjectChatMessage[]
  loading: boolean
  error: string
  errorKind: 'default' | 'conflict' | 'unconfirmed' | 'saved-detail'
  commentError: string
  editing: boolean
  busy: boolean
  associationPending: boolean
}
type CreatedProjectIssue = { project_id: string; issue_id: string; restricted?: boolean }

export type CreateSharedIssue = (
  input: IndependentIssueInput,
  projectId?: string,
  projectStatus?: string
) => Promise<SharedIssueTarget>

interface DialogCallbacks {
  onClose(): void
  onSaved(issue: IndependentIssue | null): void
  onOpenProjectIssue?(projectId: string, issueId: string, restricted?: boolean): void
  onMovedToProject?(projectId: string, issueId: string): void
}
interface Observer extends DialogCallbacks {
  listener(): void
}
let nextDialogScope = 0
const message = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason))
const apiStatus = (reason: unknown) =>
  reason instanceof Error && 'status' in reason && typeof reason.status === 'number'
    ? reason.status
    : 0
const denied = (reason: unknown) => [403, 404].includes(apiStatus(reason))

/** One personal-Issue scope owns its read results, saved row and explicit transactions. */
export function createIndependentIssueDialogState(
  api: PersonalIssuesApi,
  userId: number,
  issueId: string | null
) {
  const key = `${userId}:${issueId ?? 'new'}:${++nextDialogScope}`
  const observers = new Set<Observer>()
  let snapshot: DialogSnapshot = {
    issue: null,
    comments: [],
    loading: Boolean(issueId),
    error: '',
    errorKind: 'default',
    commentError: '',
    editing: !issueId,
    busy: false,
    associationPending: false,
  }
  let loadId = issueId
  let savedIssueToOpen: string | null = null
  let started = false
  let lifetime = 0
  let issueReadVersion = 0
  let commentReadVersion = 0
  let accessVersion = 0
  const owned = (generation = lifetime) => generation === lifetime && observers.size > 0
  const readUnlinkedIssue = (id: string) => api.issueDetail(id).then(unlinkedIssueFromDetail)
  function publish(change: Partial<DialogSnapshot>) {
    if (
      Object.entries(change).every(
        ([key, value]) => snapshot[key as keyof DialogSnapshot] === value
      )
    )
      return
    snapshot = { ...snapshot, ...change }
    for (const observer of [...observers]) {
      if (observers.has(observer)) observer.listener()
    }
  }
  function notify(action: (observer: Observer) => void) {
    for (const observer of [...observers]) {
      if (observers.has(observer)) action(observer)
    }
  }
  function clearDenied(reason: unknown, comments = false) {
    issueReadVersion += 1
    commentReadVersion += 1
    accessVersion += 1
    publish({
      busy: false,
      issue: null,
      comments: [],
      editing: false,
      loading: false,
      error: message(reason),
      errorKind: 'default',
      associationPending: false,
      ...(comments ? { commentError: message(reason) } : {}),
    })
  }
  async function readIssue(id: string, current: () => boolean) {
    if (!current()) return
    try {
      const detail = await api.issueDetail(id)
      if (!current()) return
      const projectId = detailProjectId(detail)
      if (projectId && [...observers].some(observer => observer.onMovedToProject)) {
        commentReadVersion += 1
        publish({ issue: null, comments: [], editing: false })
        notify(observer => observer.onMovedToProject?.(projectId, id))
        return
      }
      const row = unlinkedIssueFromDetail(detail)
      publish({ issue: row, error: '', errorKind: 'default' })
      if (savedIssueToOpen === id) {
        savedIssueToOpen = null
        notify(observer => observer.onSaved(row))
      }
      return row
    } catch (reason) {
      if (!current()) return
      if (savedIssueToOpen === id) publish({ error: message(reason), errorKind: 'saved-detail' })
      else if (denied(reason)) clearDenied(reason)
      else publish({ error: message(reason) })
    } finally {
      if (current()) publish({ loading: false })
    }
  }
  async function readComments(id: string, current: () => boolean) {
    if (!current()) return
    try {
      const comments = await api.comments(id)
      if (current()) publish({ comments, commentError: '' })
    } catch (reason) {
      if (!current()) return
      // The detail read owns navigation when an old standalone link has moved.
      if (
        savedIssueToOpen !== id &&
        denied(reason) &&
        !(snapshot.loading && apiStatus(reason) === 404)
      )
        clearDenied(reason, true)
      else publish({ commentError: message(reason) })
    }
  }
  function load() {
    if (!owned() || !loadId) return
    const generation = lifetime
    const issueVersion = ++issueReadVersion
    const commentVersion = ++commentReadVersion
    publish({ loading: true })
    void readIssue(loadId, () => owned(generation) && issueVersion === issueReadVersion)
    void readComments(loadId, () => owned(generation) && commentVersion === commentReadVersion)
  }
  async function run(operation: (current: () => boolean) => Promise<void>) {
    if (!owned() || snapshot.busy) return false
    const generation = lifetime
    const wasEditing = snapshot.editing
    const access = accessVersion
    const current = () => owned(generation) && access === accessVersion
    // A write supersedes old detail reads without dropping an independent comment load.
    issueReadVersion += 1
    publish({ busy: true, loading: false, error: '', errorKind: 'default' })
    try {
      await operation(current)
      return current()
    } catch (reason) {
      if (!current()) return false
      const unconfirmed = wasEditing && (reason instanceof TypeError || apiStatus(reason) >= 500)
      publish({
        error: message(reason),
        errorKind: unconfirmed
          ? 'unconfirmed'
          : wasEditing && apiStatus(reason) === 409
            ? 'conflict'
            : 'default',
      })
      return false
    } finally {
      if (current()) publish({ busy: false })
    }
  }
  const projectCreationRequests = new Map<string, string>()
  function openProjectIssue(target: CreatedProjectIssue, current: () => boolean) {
    notify(observer => {
      observer.onSaved(null)
      if (!current()) return
      observer.onOpenProjectIssue?.(target.project_id, target.issue_id, target.restricted)
      if (current()) observer.onClose()
    })
  }
  function refreshSavedIssue() {
    if (snapshot.associationPending && snapshot.issue) {
      const row = snapshot.issue
      notify(observer => observer.onSaved(row))
    }
  }
  async function saveIssueUpdate<Result>(
    id: string,
    update: (issue: IndependentIssue) => Promise<Result>,
    savedIssue: (result: Result) => IndependentIssue | Promise<IndependentIssue>
  ) {
    const issue = snapshot.issue
    if (!owned() || issue?.id !== id) throw new Error('Issue detail scope changed')
    const owner = lifetime
    const access = accessVersion
    const isCurrent = () => owned(owner) && access === accessVersion
    const result = await update(issue)
    if (!isCurrent()) throw new Error('Issue detail scope changed')
    const row = await savedIssue(result)
    if (!isCurrent()) throw new Error('Issue detail scope changed')
    if (snapshot.issue && row.version < snapshot.issue.version) return result
    issueReadVersion += 1
    publish({ issue: row })
    notify(observer => observer.onSaved(row))
    return result
  }
  return {
    key,
    getSnapshot: () => snapshot,
    isOwned: () => owned(),
    subscribe(listener: () => void, callbacks: DialogCallbacks) {
      const observer = { ...callbacks, listener }
      observers.add(observer)
      if (!started) {
        started = true
        load()
      }
      return () => {
        observers.delete(observer)
        queueMicrotask(() => {
          if (observers.size > 0) return
          lifetime += 1
          issueReadVersion += 1
          commentReadVersion += 1
          started = false
          snapshot = { ...snapshot, busy: false }
        })
      }
    },
    refreshSavedIssue,
    retry: load,
    reloadLatest() {
      if (!owned() || !snapshot.issue || snapshot.busy) return
      refreshSavedIssue()
      loadId = snapshot.issue.id
      publish({ editing: false, error: '', errorKind: 'default', associationPending: false })
      load()
    },
    beginEdit() {
      if (owned() && !snapshot.busy) publish({ editing: true })
    },
    cancelEdit() {
      if (owned()) publish({ editing: false })
    },
    clearActionError() {
      if (owned()) publish({ error: '' })
    },
    save(values: IssueCreationInput, createShared?: CreateSharedIssue) {
      if (savedIssueToOpen) return Promise.resolve()
      const { project_id, project_status, ...input } = values
      return run(async current => {
        if (createShared) {
          const target = await createShared(input, project_id, project_status)
          if (!current()) return
          if (target.project_id) {
            openProjectIssue(
              {
                project_id: target.project_id,
                issue_id: target.id,
                restricted: target.restricted && !input.participants.length,
              },
              current
            )
            return
          }
          loadId = savedIssueToOpen = target.id
          publish({ loading: true, editing: false })
          await readIssue(target.id, current)
          return
        }
        const existing = snapshot.issue
        if (!existing && project_id) {
          const requestId = projectCreationRequests.get(project_id) ?? crypto.randomUUID()
          projectCreationRequests.set(project_id, requestId)
          const target = await api.createInProject(input, project_id, project_status, requestId)
          if (current()) openProjectIssue(target, current)
          return
        }
        const row = existing
          ? await updateIssueDraft(api, existing, input)
          : await api.create(input)
        if (!current()) return
        // Retain the successfully created row before starting the separate association transaction.
        issueReadVersion += 1
        publish({ issue: row, loading: false, associationPending: Boolean(project_id) })
        if (project_id) {
          const target = await api.associate(row.id, project_id, row.version, project_status ?? '')
          if (!current()) return
          publish({ associationPending: false })
          openProjectIssue(target, current)
          return
        }
        publish({ editing: false })
        loadId = row.id
        if (!row.detail) {
          if (!existing) savedIssueToOpen = row.id
          publish({ loading: true })
          const refreshed = await readIssue(row.id, current)
          if (existing && current() && snapshot.issue?.id === row.id)
            notify(observer => observer.onSaved(refreshed ?? row))
        } else {
          notify(observer => observer.onSaved(row))
        }
      }).then(() => undefined)
    },
    updateDetail(id: string, input: SharedIssueDetailUpdateInput) {
      return saveIssueUpdate(
        id,
        () =>
          api.updateDetail(id, {
            version: input.version,
            title: input.title,
            description: input.description,
            due_at: input.due_at,
            priority: input.priority,
            status: input.status,
            assignee_user_id: input.assignee_user_id,
            assignee_agent_id: input.assignee_agent_id,
            assignee_group_id: input.assignee_group_id,
            assignee_team_id: input.assignee_team_id,
            notify_assignee: input.notify_assignee,
          }),
        row => row
      )
    },
    addParticipant(id: string, person: number) {
      return saveIssueUpdate(
        id,
        () => api.addCollaborator(id, person),
        () => readUnlinkedIssue(id)
      )
    },
    removeParticipant(id: string, person: number) {
      return saveIssueUpdate(
        id,
        () => api.removeCollaborator(id, person),
        () => readUnlinkedIssue(id)
      )
    },
    sendComment(value: string, mentionedUsers: number[] = []) {
      const issue = snapshot.issue
      const body = value.trim()
      if (!issue || !body) return Promise.resolve(false)
      return run(async current => {
        await api.comment(issue.id, body, mentionedUsers)
        if (!current()) return
        const issueVersion = ++issueReadVersion
        const row = await readIssue(issue.id, () => current() && issueVersion === issueReadVersion)
        if (row && current()) notify(observer => observer.onSaved(row))
        if (current()) {
          const version = ++commentReadVersion
          await readComments(issue.id, () => current() && version === commentReadVersion)
        }
      })
    },
    toggleArchive() {
      const issue = snapshot.issue
      if (!issue) return Promise.resolve(false)
      return run(async current => {
        const row = await api.updateDetail(issue.id, {
          version: issue.version,
          archived: !issue.metadata.archived,
        })
        if (!current()) return
        issueReadVersion += 1
        publish({ issue: row, loading: false })
        notify(observer => observer.onSaved(row))
      })
    },
    associate(projectId: string, status: string) {
      const issue = snapshot.issue
      if (!issue) return Promise.resolve(false)
      return run(async current => {
        const linked = await api.associate(issue.id, projectId, issue.version, status)
        if (!current()) return
        notify(observer => {
          observer.onSaved(null)
          if (current()) observer.onOpenProjectIssue?.(linked.project_id, linked.issue_id)
        })
      })
    },
    remove() {
      const issue = snapshot.issue
      if (!issue) return Promise.resolve(false)
      return run(async current => {
        try {
          await api.remove(issue.id, issue.version)
        } catch (reason) {
          if (!current()) return
          if (apiStatus(reason) === 403) {
            clearDenied(reason)
            return
          }
          if (apiStatus(reason) !== 404) throw reason
        }
        if (!current()) return
        loadId = null
        issueReadVersion += 1
        commentReadVersion += 1
        publish({
          issue: null,
          comments: [],
          editing: false,
          loading: false,
          associationPending: false,
        })
        notify(observer => observer.onSaved(null))
      })
    },
  }
}
