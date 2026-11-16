import { useCallback, useRef, useState } from 'react'

export function useScopedDraftInput(initialInputs: () => Record<string, string>) {
  const [inputs, setInputs] = useState(initialInputs)
  const currentInputs = useRef(inputs)
  const revisions = useRef(new Map<string, number>())
  const getRevision = useCallback((scopeKey: string) => revisions.current.get(scopeKey) ?? 0, [])
  const replaceInputs = useCallback((values: Record<string, string>) => {
    const current = currentInputs.current
    const scopes = new Set([...Object.keys(current), ...Object.keys(values)])
    let changed = false
    for (const scopeKey of scopes) {
      if ((current[scopeKey] ?? '') === (values[scopeKey] ?? '')) continue
      revisions.current.set(scopeKey, (revisions.current.get(scopeKey) ?? 0) + 1)
      changed = true
    }
    if (!changed) return
    const next = Object.fromEntries(Object.entries(values).filter(([, value]) => value))
    currentInputs.current = next
    setInputs(next)
  }, [])
  const setInput = useCallback(
    (scopeKey: string, value: string) => {
      replaceInputs({ ...currentInputs.current, [scopeKey]: value })
    },
    [replaceInputs]
  )
  return { inputs, setInput, getRevision, replaceInputs }
}
