import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  canCommentCollaborationIssue,
  type CollaborationIssue,
  type CollaborationProject,
  type SharedWorkspaceApi,
} from '@wegent/collaboration'
import type { useExperienceDraftInput } from '../useExperienceDraftInput'

export type ConclusionPublicationError = 'permission' | 'archived' | 'stale' | 'failed' | 'refresh'

interface ConclusionPublicationInput {
  api: SharedWorkspaceApi
  project: CollaborationProject
  issue: CollaborationIssue
  accountKey: string
  scopeKey: string
  expectedUserId: number
  active: boolean
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

export function useConclusionPublication(input: ConclusionPublicationInput) {
  const key = publicationKey(input)
  const body = input.draft.value.trim()
  const latest = useRef(input)
  useLayoutEffect(() => {
    latest.current = input
  }, [input])
  const generation = useRef(0)
  const [operationSource] = useState(() => createPublicationOperation(key))
  const operation = useSyncExternalStore(
    operationSource.subscribe,
    operationSource.getSnapshot,
    operationSource.getSnapshot
  )
  const setOperation = operationSource.set
  useLayoutEffect(() => {
    const state = stateFor(key)
    state.users += 1
    return () => {
      state.users -= 1
      releaseUnused(key, state)
    }
  }, [key])
  useLayoutEffect(() => {
    generation.current += 1
  }, [key, body, input.api, input.active, input.draft.revision, input.expectedUserId])

  async function publish() {
    const request = latest.current
    const body = request.draft.value.trim()
    const key = publicationKey(request)
    const state = stateFor(key)
    if (
      !operationSource.isActive() ||
      !request.active ||
      !body ||
      state.pending ||
      request.draft.getValue().trim() !== body
    )
      return false
    state.pending = true
    const requestGeneration = generation.current
    const lifetime = operationSource.getGeneration()
    const stillCurrent = () =>
      operationSource.isActive() &&
      operationSource.getGeneration() === lifetime &&
      generation.current === requestGeneration &&
      latest.current.accountKey === request.accountKey &&
      publicationKey(latest.current) === key &&
      latest.current.api === request.api &&
      latest.current.expectedUserId === request.expectedUserId &&
      latest.current.active &&
      latest.current.draft.value.trim() === body
    setOperation({ scopeKey: key, publishing: true, error: null })
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
        if (
          operationSource.isActive() &&
          publicationKey(latest.current) === key &&
          operationSource.getGeneration() === lifetime
        )
          setOperation({ scopeKey: key, publishing: false, error: 'stale' })
        return false
      }
      if (project.status === 'archived' || issue.status === 'archived' || issue.archived_at) {
        setOperation({ scopeKey: key, publishing: false, error: 'archived' })
        return false
      }
      if (!canCommentCollaborationIssue(project, issue)) {
        setOperation({ scopeKey: key, publishing: false, error: 'permission' })
        return false
      }
      submission = request.draft.beginSubmission(request.draft.value)
      await request.api.comments.create(issue.id, body, {
        clientMessageId: submission.clientMessageId,
      })
      published = true
      submission.clearIfUnchanged()
      await request.onPublished()
      return true
    } catch {
      if (
        operationSource.isActive() &&
        publicationKey(latest.current) === key &&
        operationSource.getGeneration() === lifetime
      )
        setOperation({
          scopeKey: key,
          publishing: false,
          error: published ? 'refresh' : 'failed',
        })
      return published
    } finally {
      submission?.release()
      state.pending = false
      releaseUnused(key, state)
      if (
        operationSource.isActive() &&
        publicationKey(latest.current) === key &&
        operationSource.getGeneration() === lifetime
      )
        setOperation(current =>
          current.scopeKey === key ? { ...current, publishing: false } : current
        )
    }
  }

  return {
    publish,
    getOperation: operationSource.getSnapshot,
    publishing: operation.scopeKey === key && operation.publishing,
    error: operation.scopeKey === key ? operation.error : null,
  }
}

interface PublicationOperation {
  scopeKey: string
  publishing: boolean
  error: ConclusionPublicationError | null
}

/** The live operation snapshot owns its observers and fences detached async completions. */
function createPublicationOperation(scopeKey: string) {
  let snapshot: PublicationOperation = { scopeKey, publishing: false, error: null }
  let generation = 0
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    getGeneration: () => generation,
    isActive: () => listeners.size > 0,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (!listeners.size) generation += 1
      }
    },
    set(value: PublicationOperation | ((current: PublicationOperation) => PublicationOperation)) {
      if (!listeners.size) return
      const next = typeof value === 'function' ? value(snapshot) : value
      if (next === snapshot) return
      snapshot = next
      listeners.forEach(listener => listener())
    },
  }
}
