import { useCallback, useRef, useState } from 'react'

export function useScopedDraftInput(initialInputs: () => Record<string, string>) {
  const [inputs, setInputs] = useState(initialInputs)
  const currentInputs = useRef(inputs)
  const revisions = useRef(new Map<string, number>())
  const getRevision = useCallback((scopeKey: string) => revisions.current.get(scopeKey) ?? 0, [])
  const setInput = useCallback((scopeKey: string, value: string) => {
    const current = currentInputs.current
    if ((current[scopeKey] ?? '') === value) return
    const next = { ...current }
    if (value) next[scopeKey] = value
    else delete next[scopeKey]
    currentInputs.current = next
    revisions.current.set(scopeKey, (revisions.current.get(scopeKey) ?? 0) + 1)
    setInputs(next)
  }, [])
  const replaceInputs = useCallback((next: Record<string, string>) => {
    const current = currentInputs.current
    const changedScopes = [...new Set([...Object.keys(current), ...Object.keys(next)])].filter(
      key => (current[key] ?? '') !== (next[key] ?? '')
    )
    if (!changedScopes.length) return
    for (const key of changedScopes) {
      revisions.current.set(key, (revisions.current.get(key) ?? 0) + 1)
    }
    currentInputs.current = { ...next }
    setInputs(currentInputs.current)
  }, [])
  return { inputs, setInput, getRevision, replaceInputs }
}
