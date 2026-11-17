import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AssistantRequestAction,
  AssistantRequestList,
  AssistantRequestsApi,
} from '@wegent/collaboration'

interface Input {
  api: AssistantRequestsApi
  projectId: string
  issueId: string
  userId: number
  accountKey: string
  active: boolean
  revision: number
}

type Mutation =
  | AssistantRequestAction
  | {
      action: 'confirm_merge'
      requestId: string
      targetRevision: string
      candidateRevision: string
    }

export function useAssistantRequests(input: Input) {
  const { api, projectId, issueId, userId, accountKey, active, revision } = input
  const scope = useMemo(
    () => ({ api, projectId, issueId, userId, accountKey }),
    [api, projectId, issueId, userId, accountKey]
  )
  const currentScope = useRef<typeof scope | null>(null)
  useEffect(() => {
    currentScope.current = scope
    return () => {
      if (currentScope.current === scope) currentScope.current = null
    }
  }, [scope])
  const sequence = useRef(0)
  const [refresh, setRefresh] = useState(0)
  const [snapshot, setSnapshot] = useState<{
    scope: typeof scope
    list: AssistantRequestList | null
    failed: boolean
    loading: boolean
  }>({ scope, list: null, failed: false, loading: true })
  const [sending, setSending] = useState<typeof scope | null>(null)
  const submission = useRef<typeof scope | null>(null)
  const [sendFailure, setSendFailure] = useState<typeof scope | null>(null)
  const attempts = useRef({ scope, keys: new Map<string, string>() })

  useEffect(() => {
    if (!active) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      const operation = ++sequence.current
      setSnapshot(previous => ({
        scope,
        list: previous.scope === scope ? previous.list : null,
        failed: false,
        loading: true,
      }))
      try {
        const list = await api.list(projectId, issueId)
        if (list.requests.some(request => request.ownerUserId !== userId))
          throw new Error('Assistant request owner mismatch')
        if (cancelled || currentScope.current !== scope || operation !== sequence.current) return
        setSnapshot({ scope, list, failed: false, loading: false })
        if (list.enabled || list.requests.length) timer = setTimeout(() => void load(), 5000)
      } catch {
        if (!cancelled && currentScope.current === scope && operation === sequence.current)
          setSnapshot(previous => ({
            scope,
            list: previous.scope === scope ? previous.list : null,
            failed: true,
            loading: false,
          }))
      }
    }
    void load()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [scope, api, projectId, issueId, userId, active, revision, refresh])

  const perform = useCallback(
    async (action: Mutation) => {
      if (!active || submission.current === scope || currentScope.current !== scope) return false
      const signature = JSON.stringify(action)
      if (attempts.current.scope !== scope) attempts.current = { scope, keys: new Map() }
      const keys = attempts.current.keys
      const idempotencyKey = keys.get(signature) ?? crypto.randomUUID()
      keys.set(signature, idempotencyKey)
      submission.current = scope
      setSending(scope)
      setSendFailure(null)
      ++sequence.current
      try {
        const request =
          action.action === 'confirm_merge'
            ? await api.confirmMerge(projectId, issueId, action.requestId, {
                idempotencyKey,
                targetRevision: action.targetRevision,
                candidateRevision: action.candidateRevision,
              })
            : await api.submit(projectId, issueId, { ...action, idempotencyKey })
        if (request.ownerUserId !== userId) throw new Error('Assistant request owner mismatch')
        if (currentScope.current !== scope) return false
        keys.delete(signature)
        setSnapshot(previous => ({
          scope,
          list: {
            enabled: previous.scope === scope && previous.list?.enabled === true,
            requests: [
              request,
              ...(previous.scope === scope ? (previous.list?.requests ?? []) : []).filter(
                row => row.requestId !== request.requestId
              ),
            ],
          },
          failed: false,
          loading: false,
        }))
        setRefresh(value => value + 1)
        return true
      } catch {
        if (currentScope.current === scope) setSendFailure(scope)
        return false
      } finally {
        if (submission.current === scope) submission.current = null
        if (currentScope.current === scope) setSending(null)
      }
    },
    [scope, api, projectId, issueId, userId, active]
  )
  const visible = snapshot.scope === scope ? snapshot : null
  return {
    list: visible?.list ?? null,
    loading: active && (visible?.loading ?? true),
    failed: visible?.failed ?? false,
    sending: sending === scope,
    sendFailed: sendFailure === scope,
    refresh: () => setRefresh(value => value + 1),
    submit: (action: AssistantRequestAction) => perform(action),
    confirmMerge: (requestId: string, targetRevision: string, candidateRevision: string) =>
      perform({ action: 'confirm_merge', requestId, targetRevision, candidateRevision }),
  }
}
