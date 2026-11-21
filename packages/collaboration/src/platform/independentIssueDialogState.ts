import {
  independentIssueInput,
  resolveMovedPersonalIssue,
  type IndependentIssue,
  type IndependentIssueComment,
  type IndependentIssueInput,
  type IssueCreationInput,
  type PersonalIssuesApi,
  type SharedIssueTarget,
} from './personalIssuesApi'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'

interface DialogSnapshot {
  issue: IndependentIssue | null
  comments: IndependentIssueComment[]
  loading: boolean
  error: string
  errorKind: 'default' | 'conflict' | 'unconfirmed'
  commentError: string
  editing: boolean
  busy: boolean
  body: string
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
  issueId: string | null,
  projectIssues?: SharedWorkspaceApi['issues']
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
    body: '',
    associationPending: false,
  }
  let loadId = issueId
  let started = false
  let lifetime = 0
  let issueReadVersion = 0
  let commentReadVersion = 0
  let accessVersion = 0
  const owned = (generation = lifetime) => generation === lifetime && observers.size > 0
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
      body: '',
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
      const row = await api.get(id)
      if (current()) publish({ issue: row, error: '', errorKind: 'default' })
    } catch (reason) {
      if (!current()) return
      if (projectIssues && apiStatus(reason) === 404) {
        const projectId = await resolveMovedPersonalIssue(reason, () => projectIssues.get(id))
        if (!current()) return
        if (projectId) {
          notify(observer => observer.onMovedToProject?.(projectId, id))
          return
        }
      }
      if (denied(reason)) clearDenied(reason)
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
      if (denied(reason) && !(projectIssues && snapshot.loading && apiStatus(reason) === 404))
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
      const unconfirmed =
        wasEditing &&
        (reason instanceof TypeError || apiStatus(reason) >= 500)
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
    editComment(body: string) {
      if (owned()) publish({ body })
    },
    reportTaskError(error: string) {
      if (owned()) publish({ error })
    },
    clearActionError() {
      if (owned()) publish({ error: '' })
    },
    save(values: IssueCreationInput, createShared?: CreateSharedIssue) {
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
          const row = await api.get(target.id)
          if (!current()) return
          issueReadVersion += 1
          publish({ issue: row, loading: false, editing: false })
          notify(observer => observer.onSaved(row))
          return
        }
        const existing = snapshot.issue
        const row = existing
          ? await api.update(existing.id, { ...input, version: existing.version })
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
        notify(observer => observer.onSaved(row))
      }).then(() => undefined)
    },
    sendComment() {
      const issue = snapshot.issue
      const body = snapshot.body.trim()
      if (!issue || !body) return Promise.resolve(false)
      return run(async current => {
        await api.comment(issue.id, body)
        if (!current()) return
        publish({ body: '' })
        let row: IndependentIssue
        try {
          row = await api.get(issue.id)
        } catch (reason) {
          if (!current()) return
          if (denied(reason)) {
            clearDenied(reason)
            return
          }
          throw reason
        }
        if (!current()) return
        issueReadVersion += 1
        publish({ issue: row, loading: false })
        notify(observer => observer.onSaved(row))
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
        const row = await api.update(issue.id, {
          ...independentIssueInput(issue),
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
          body: '',
          editing: false,
          loading: false,
          associationPending: false,
        })
        notify(observer => observer.onSaved(null))
      })
    },
  }
}
