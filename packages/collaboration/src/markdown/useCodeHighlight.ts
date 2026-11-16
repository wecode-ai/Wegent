import { useEffect, useRef, useState } from 'react'
import { codeHighlightClient } from './codeHighlightClient'
import type { HighlightedCode } from './highlightCode'

/** Coalesce streaming updates while a worker is busy and reject stale language/text results. */
export function useCodeHighlight(code: string, language: string): HighlightedCode | null {
  const [result, setResult] = useState<(HighlightedCode & { language: string }) | null>(null)
  const state = useRef({
    code,
    language,
    disposed: false,
    generation: 0,
    busy: false,
  })

  useEffect(() => {
    const current = state.current
    current.disposed = false
    current.generation += 1
    const release = codeHighlightClient.retain()
    return () => {
      current.disposed = true
      current.generation += 1
      release()
    }
  }, [])

  useEffect(() => {
    const current = state.current
    current.code = code
    current.language = language
    const run = () => {
      if (current.busy || current.disposed) return
      const snapshot = {
        code: current.code,
        language: current.language,
        generation: current.generation,
      }
      current.busy = true
      void codeHighlightClient
        .highlight(snapshot.code, snapshot.language)
        .then(
          highlighted => {
            if (
              !current.disposed &&
              snapshot.generation === current.generation &&
              current.language === snapshot.language &&
              current.code.startsWith(highlighted.code)
            ) {
              setResult({ ...highlighted, language: snapshot.language })
            }
          },
          error => {
            if (!current.disposed && snapshot.generation === current.generation)
              console.error('[code-highlight]', error)
          }
        )
        .finally(() => {
          current.busy = false
          if (
            current.code !== snapshot.code ||
            current.language !== snapshot.language ||
            current.generation !== snapshot.generation
          )
            run()
        })
    }
    run()
  }, [code, language])

  return result?.language === language ? result : null
}
