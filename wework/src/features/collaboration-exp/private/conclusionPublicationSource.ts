import {
  canCommentCollaborationIssue,
  type CollaborationIssue,
  type CollaborationProject,
  type SharedWorkspaceApi,
} from '@wegent/collaboration'
import type { useExperienceDraftInput } from '../useExperienceDraftInput'

export type ConclusionPublicationError = 'permission' | 'archived' | 'stale' | 'failed' | 'refresh'

export interface ConclusionPublicationInput {
  api: SharedWorkspaceApi
  project: CollaborationProject
  issue: CollaborationIssue
  accountKey: string
  scopeKey: string
  expectedUserId: number
  active: boolean
  assistantSource?: { deviceId: string; taskId: string } | null
  draft: Pick<
    ReturnType<typeof useExperienceDraftInput>,
    'value' | 'revision' | 'getValue' | 'beginSubmission'
  >
  onPublished(): void | Promise<void>
}

interface PublicationState {
  users: number
  pending: boolean
}
const publications = new Map<string, PublicationState>()
const publicationKey = (input: ConclusionPublicationInput) =>
  JSON.stringify([input.accountKey, input.scopeKey])

function stateFor(key: string) {
  let state = publications.get(key)
  if (!state) {
    state = { users: 0, pending: false }
    publications.set(key, state)
  }
  return state
}

function releaseUnused(key: string, state: PublicationState) {
  if (!state.users && !state.pending) publications.delete(key)
}

/** The committed review owns its request input, visible operation and async fences. */
export function createConclusionPublicationSource(scopeKey: string) {
  let snapshot: PublicationOperation = { scopeKey, publishing: false, error: null }
  let input: ConclusionPublicationInput | null = null
  let revision = 0
  let lifetime = 0
  let connectionVersion = 0
  let heldKey: string | null = null
  let heldState: PublicationState | null = null
  const listeners = new Set<() => void>()
  const isActive = () => listeners.size > 0
  const releaseRegistry = () => {
    if (heldKey && heldState) {
      heldState.users -= 1
      releaseUnused(heldKey, heldState)
    }
    heldKey = null
    heldState = null
  }
  const commit = (next: ConclusionPublicationInput) => {
    const key = publicationKey(next)
    if (heldKey !== key) {
      releaseRegistry()
      heldKey = key
      heldState = stateFor(key)
      heldState.users += 1
    }
    const previous = input
    if (
      !previous ||
      publicationKey(previous) !== key ||
      previous.draft.value.trim() !== next.draft.value.trim() ||
      previous.draft.revision !== next.draft.revision ||
      previous.api !== next.api ||
      previous.active !== next.active ||
      previous.expectedUserId !== next.expectedUserId ||
      previous.project.id !== next.project.id ||
      previous.project.project_store !== next.project.project_store ||
      previous.issue.id !== next.issue.id ||
      previous.assistantSource?.deviceId !== next.assistantSource?.deviceId ||
      previous.assistantSource?.taskId !== next.assistantSource?.taskId
    )
      revision += 1
    input = next
  }
  const set = (
    value: PublicationOperation | ((current: PublicationOperation) => PublicationOperation)
  ) => {
    if (!isActive()) return
    const next = typeof value === 'function' ? value(snapshot) : value
    if (next === snapshot) return
    snapshot = next
    listeners.forEach(listener => listener())
  }
  async function publish() {
    const request = input
    if (!request || !isActive()) return false
    const body = request.draft.value.trim()
    const key = publicationKey(request)
    const state = stateFor(key)
    if (
      !isActive() ||
      !request.active ||
      !body ||
      state.pending ||
      request.draft.getValue().trim() !== body
    )
      return false
    state.pending = true
    const requestGeneration = revision
    const requestLifetime = lifetime
    const stillCurrent = () =>
      isActive() &&
      lifetime === requestLifetime &&
      revision === requestGeneration &&
      input!.accountKey === request.accountKey &&
      publicationKey(input!) === key &&
      input!.api === request.api &&
      input!.expectedUserId === request.expectedUserId &&
      input!.active &&
      input!.draft.value.trim() === body
    set({ scopeKey: key, publishing: true, error: null })
    let published = false
    let submission: ReturnType<ConclusionPublicationInput['draft']['beginSubmission']> | undefined
    try {
      const [project, issue] = await Promise.all([
        request.api.projects.get(request.project.id),
        request.api.issues.get(request.issue.id),
      ])
      if (
        !stillCurrent() ||
        project.id !== request.project.id ||
        project.project_store !== request.project.project_store ||
        issue.id !== request.issue.id ||
        issue.cloud_project_id !== project.id ||
        (project.current_user_id !== undefined &&
          project.current_user_id !== request.expectedUserId)
      ) {
        if (isActive() && publicationKey(input!) === key && lifetime === requestLifetime)
          set({ scopeKey: key, publishing: false, error: 'stale' })
        return false
      }
      if (project.status === 'archived' || issue.status === 'archived' || issue.archived_at) {
        set({ scopeKey: key, publishing: false, error: 'archived' })
        return false
      }
      if (!canCommentCollaborationIssue(project, issue)) {
        set({ scopeKey: key, publishing: false, error: 'permission' })
        return false
      }
      submission = request.draft.beginSubmission(request.draft.value)
      if (request.assistantSource) {
        if (!request.api.comments.createAssistantPublication) {
          throw new Error('Assistant publication service is unavailable')
        }
        await request.api.comments.createAssistantPublication(issue.id, body, {
          clientMessageId: submission.clientMessageId,
          projectId: project.id,
          assistantSource: request.assistantSource,
        })
      } else {
        await request.api.comments.create(issue.id, body, {
          clientMessageId: submission.clientMessageId,
          projectId: project.id,
        })
      }
      published = true
      submission.clearIfUnchanged()
      await request.onPublished()
      return true
    } catch {
      if (isActive() && publicationKey(input!) === key && lifetime === requestLifetime)
        set({
          scopeKey: key,
          publishing: false,
          error: published ? 'refresh' : 'failed',
        })
      return published
    } finally {
      submission?.release()
      state.pending = false
      releaseUnused(key, state)
      if (isActive() && publicationKey(input!) === key && lifetime === requestLifetime)
        set(current => (current.scopeKey === key ? { ...current, publishing: false } : current))
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(next: ConclusionPublicationInput, listener: () => void) {
      connectionVersion += 1
      commit(next)
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        const version = ++connectionVersion
        if (!listeners.size)
          queueMicrotask(() => {
            if (listeners.size || connectionVersion !== version) return
            lifetime += 1
            releaseRegistry()
          })
      }
    },
    publish,
  }
}

interface PublicationOperation {
  scopeKey: string
  publishing: boolean
  error: ConclusionPublicationError | null
}
