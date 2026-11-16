// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from 'react'
import client, { ApiError } from '@/apis/client'
import { knowledgePermissionApi } from '@/apis/knowledge-permission'
import { useUser } from '@/features/common/UserContext'
import { ASSIGNABLE_ROLES } from '@/types/base-role'
import type { AuthEntry } from '../../document/auth-section-registry'
import type { BatchPermissionAddResponse } from '@/types/knowledge'

export interface GrantFailure {
  entry: AuthEntry
  error: string
}
interface GrantOptions {
  kbId: number
  onChanged?: () => void
  onAccessDenied?: () => void
}
const key = (type: string | null | undefined, id: string | number | null | undefined) =>
  JSON.stringify([type || 'user', String(id)])
const entryKey = (entry: AuthEntry) => key(entry.entityType, entry.entityId)

function classify(entries: AuthEntry[], result: BatchPermissionAddResponse) {
  const failures: GrantFailure[] = [],
    unconfirmed: AuthEntry[] = []
  const succeeded = new Map(
    result.succeeded.map(member => [
      key(member.entity_type, member.entity_id ?? member.user_id),
      member.role,
    ])
  )
  const failed = new Map(
    result.failed.map(member => [
      key(member.entity_type, member.entity_id ?? member.user_id),
      member.error,
    ])
  )
  for (const entry of entries) {
    const id = entryKey(entry)
    if (failed.has(id)) failures.push({ entry, error: failed.get(id)! })
    else if (succeeded.get(id) !== entry.role) unconfirmed.push(entry)
  }
  return { failures, unconfirmed, succeeded: entries.length - failures.length - unconfirmed.length }
}

/** Submit bounded batches; retries first reconcile exact persisted bindings. */
export function useKnowledgeGrants(options: GrantOptions) {
  const { user } = useUser()
  const cacheScope = client.getCacheScope()
  const scope = JSON.stringify([user?.id, cacheScope, options.kbId])
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const callbacks = useRef(options)
  callbacks.current = options
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const generation = useRef(0)
  const busy = useRef(false)
  const attempted = useRef(false)
  const unresolved = useRef<AuthEntry[]>([])
  const [stateScope, setStateScope] = useState(scope)
  const [loading, setLoading] = useState(false)
  const [failures, setFailures] = useState<GrantFailure[]>([])
  const [error, setError] = useState<string | null>(null)
  const [uncertain, setUncertain] = useState(false)
  if (stateScope !== scope) {
    generation.current++
    busy.current = false
    attempted.current = false
    unresolved.current = []
    setStateScope(scope)
    setLoading(false)
    setFailures([])
    setError(null)
    setUncertain(false)
  }
  const epoch = generation.current
  const grant = useCallback(
    async (selection: AuthEntry[]): Promise<AuthEntry[] | null> => {
      const sameScope = () =>
        scopeRef.current === scope &&
        generation.current === epoch &&
        client.getCacheScope() === cacheScope
      const current = () => mounted.current && sameScope()
      if (!current() || busy.current) return null
      const targets = [
        ...new Map(
          (unresolved.current.length ? unresolved.current : selection).map(entry => [
            entryKey(entry),
            { ...entry },
          ])
        ).values(),
      ]
      if (
        targets.some(
          entry =>
            !ASSIGNABLE_ROLES.includes(entry.role) ||
            !entry.entityType ||
            !entry.entityId ||
            (entry.entityType === 'user' &&
              (!Number.isSafeInteger(Number(entry.entityId)) || Number(entry.entityId) <= 0))
        )
      ) {
        setError('invalidTarget')
        return targets
      }
      busy.current = true
      setLoading(true)
      setError(null)
      const pending = new Map<string, GrantFailure>()
      let unknown = false,
        changed = false,
        mayHaveChanged = false
      const finish = () => {
        if (!current()) return null
        const remaining = targets.filter(entry => pending.has(entryKey(entry)))
        unresolved.current = unknown ? remaining : []
        setUncertain(unknown)
        setFailures([...pending.values()])
        setError(unknown ? 'unconfirmed' : null)
        return remaining
      }
      try {
        let candidates = targets
        if (attempted.current) {
          try {
            const existing = await knowledgePermissionApi.listPermissions(options.kbId)
            if (!current()) return null
            const bindings = new Map(
              Object.values(existing.approved)
                .flat()
                .map(member => [
                  key(member.entity_type, member.entity_id ?? member.user_id),
                  member.role,
                ])
            )
            candidates = targets.filter(entry => {
              const role = bindings.get(entryKey(entry))
              if (!role) return true
              if (role !== entry.role) {
                pending.set(entryKey(entry), { entry, error: 'roleConflict' })
                unknown = true
              } else changed = true
              return false
            })
          } catch (reason) {
            if (!current()) return null
            if (reason instanceof ApiError && (reason.status === 403 || reason.status === 404))
              callbacks.current.onAccessDenied?.()
            targets.forEach(entry => pending.set(entryKey(entry), { entry, error: 'unconfirmed' }))
            unknown = true
            return finish()
          }
        }
        attempted.current = true
        for (let start = 0; start < candidates.length; start += 10) {
          const batch = candidates.slice(start, start + 10)
          try {
            const result = await knowledgePermissionApi.batchAddPermission(options.kbId, {
              members: batch.map(entry => ({
                user_id: entry.entityType === 'user' ? Number(entry.entityId) : 0,
                role: entry.role,
                entity_type: entry.entityType,
                entity_id: entry.entityId,
                entity_display_name: entry.label,
              })),
            })
            const outcome = classify(batch, result)
            changed ||= outcome.succeeded > 0
            mayHaveChanged ||= outcome.unconfirmed.length > 0
            if (!current()) return null
            outcome.failures.forEach(failure => pending.set(entryKey(failure.entry), failure))
            if (!outcome.unconfirmed.length) continue
            outcome.unconfirmed.forEach(entry =>
              pending.set(entryKey(entry), { entry, error: 'unconfirmed' })
            )
          } catch (reason) {
            const denied =
              reason instanceof ApiError && (reason.status === 403 || reason.status === 404)
            if (denied && sameScope()) callbacks.current.onAccessDenied?.()
            mayHaveChanged ||= !denied
            if (!current()) return null
            batch.forEach(entry => pending.set(entryKey(entry), { entry, error: 'unconfirmed' }))
          }
          unknown = true
          candidates
            .slice(start + 10)
            .forEach(entry => pending.set(entryKey(entry), { entry, error: 'notSubmitted' }))
          break
        }
        return finish()
      } finally {
        if (sameScope() && (changed || mayHaveChanged)) callbacks.current.onChanged?.()
        if (current()) {
          busy.current = false
          setLoading(false)
        }
      }
    },
    [scope, cacheScope, epoch, options.kbId]
  )
  return { grant, failures, loading, error, uncertain }
}
