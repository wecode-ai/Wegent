import { useWorkerPool, WorkerPoolContextProvider } from '@pierre/diffs/react'
import DiffWorker from '@pierre/diffs/worker/worker.js?worker'
import { useEffect, useMemo, type ReactNode } from 'react'
import { useCodeTheme } from '@/features/appearance/useCodeTheme'

const poolOptions = {
  workerFactory: () => new DiffWorker(),
  poolSize: 4,
  totalASTLRUCacheSize: 100,
}

const highlighterOptions = {
  preferredHighlighter: 'highlights' as const,
  useTokenTransformer: true,
  langs: ['typescript', 'javascript', 'css', 'html', 'python'],
  lineDiffType: 'word-alt' as const,
}

function CodeThemeSync({ theme }: { theme: ReturnType<typeof useCodeTheme> }) {
  const pool = useWorkerPool()
  useEffect(() => {
    // Pierre reads provider options only on mount; update its existing pool in place.
    void pool?.setRenderOptions({ theme }).catch(error => {
      console.error('[Wework] Failed to update the code theme:', error)
    })
  }, [pool, theme])
  return null
}

/** Pierre shares this pool across mounted code surfaces. */
export function PierreCodeProvider({ children }: { children: ReactNode }) {
  const theme = useCodeTheme()
  const options = useMemo(() => ({ ...highlighterOptions, theme }), [theme])
  return (
    <WorkerPoolContextProvider poolOptions={poolOptions} highlighterOptions={options}>
      <CodeThemeSync theme={theme} />
      {children}
    </WorkerPoolContextProvider>
  )
}
