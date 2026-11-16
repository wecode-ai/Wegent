import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useScopedDraftInput } from '@/features/workbench/useScopedDraftInput'
import { privateDraftPersistence } from './private/privateDraftPersistence'
import { ExperienceDraftSession } from './experienceDraftSession'

const sessions = new Map<string, ExperienceDraftSession>()
function releaseUnused(key: string, session: ExperienceDraftSession) {
  if (session.unused && sessions.get(key) === session) sessions.delete(key)
}

export interface ExperienceDraftInputOptions {
  accountKey: string
  scopeKey: string
  inputKey?: string
  initialValue?: string
  onChange?(value: string): void
}

/** Share draft revisions and native request identities across mounted views and restores. */
export function useExperienceDraftInput({
  accountKey,
  scopeKey,
  inputKey = 'content',
  initialValue = '',
  onChange,
}: ExperienceDraftInputOptions) {
  const persistence = useMemo(
    () => privateDraftPersistence(accountKey, scopeKey),
    [accountKey, scopeKey]
  )
  const drafts = useScopedDraftInput(() => ({ [inputKey]: initialValue }))
  const key = JSON.stringify([accountKey, scopeKey, inputKey])
  const session = useMemo(() => {
    const current =
      sessions.get(key) ?? new ExperienceDraftSession(persistence, inputKey, initialValue)
    sessions.set(key, current)
    return current
  }, [key, persistence, inputKey, initialValue])
  const change = useRef(onChange)
  useLayoutEffect(() => {
    change.current = onChange
  }, [onChange])
  const [error, setError] = useState<unknown>(null)
  const { replaceInputs, getRevision } = drafts
  const apply = useCallback(
    (value: string, cause: unknown) => {
      replaceInputs({ [inputKey]: value })
      setError(cause)
      change.current?.(value)
    },
    [replaceInputs, inputKey]
  )
  useLayoutEffect(() => {
    sessions.set(key, session)
    const unsubscribe = session.subscribe(apply)
    return () => {
      unsubscribe()
      releaseUnused(key, session)
    }
  }, [key, session, apply])
  const beginSubmission = (value: string) => {
    const submission = session.retain(value)
    return {
      ...submission,
      release() {
        submission.release()
        releaseUnused(key, session)
      },
    }
  }
  return {
    value: drafts.inputs[inputKey] ?? '',
    revision: getRevision(inputKey),
    getValue: () => session.value,
    persistenceError: error,
    setValue: (value: string) => session.update(value),
    beginSubmission,
  }
}
