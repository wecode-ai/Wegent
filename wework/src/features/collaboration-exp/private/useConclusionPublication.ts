import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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
  const mounted = useRef(true)
  const generation = useRef(0)
  const [operation, setOperation] = useState<{
    scopeKey: string
    publishing: boolean
    error: ConclusionPublicationError | null
  }>({ scopeKey: input.scopeKey, publishing: false, error: null })
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      generation.current += 1
    }
  }, [])
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
  }, [key, body, input.api, input.active, input.draft.revision])

  async function publish() {
    const request = latest.current
    const body = request.draft.value.trim()
    const key = publicationKey(request)
    const state = stateFor(key)
    if (!request.active || !body || state.pending || request.draft.getValue().trim() !== body)
      return false
    state.pending = true
    const requestGeneration = generation.current
    const stillCurrent = () =>
      mounted.current &&
      generation.current === requestGeneration &&
      latest.current.accountKey === request.accountKey &&
      latest.current.scopeKey === request.scopeKey &&
      latest.current.api === request.api &&
      latest.current.active &&
      latest.current.draft.value.trim() === body
    setOperation({ scopeKey: request.scopeKey, publishing: true, error: null })
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
        if (mounted.current && latest.current.scopeKey === request.scopeKey)
          setOperation({ scopeKey: request.scopeKey, publishing: false, error: 'stale' })
        return false
      }
      if (project.status === 'archived' || issue.status === 'archived' || issue.archived_at) {
        setOperation({ scopeKey: request.scopeKey, publishing: false, error: 'archived' })
        return false
      }
      if (!canCommentCollaborationIssue(project, issue)) {
        setOperation({ scopeKey: request.scopeKey, publishing: false, error: 'permission' })
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
      if (mounted.current && latest.current.scopeKey === request.scopeKey)
        setOperation({
          scopeKey: request.scopeKey,
          publishing: false,
          error: published ? 'refresh' : 'failed',
        })
      return published
    } finally {
      submission?.release()
      state.pending = false
      releaseUnused(key, state)
      if (mounted.current && latest.current.scopeKey === request.scopeKey)
        setOperation(current =>
          current.scopeKey === request.scopeKey ? { ...current, publishing: false } : current
        )
    }
  }

  return {
    publish,
    publishing: operation.scopeKey === input.scopeKey && operation.publishing,
    error: operation.scopeKey === input.scopeKey ? operation.error : null,
  }
}
