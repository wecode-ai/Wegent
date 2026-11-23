import { WorkerPoolContextProvider } from '@pierre/diffs/react'
import DiffWorker from '@pierre/diffs/worker/worker.js?worker'
import { useMemo, type ReactNode } from 'react'
import { CodeAppearanceSync } from '@/features/appearance/AppearanceProvider'
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

/** Pierre shares this pool across mounted code surfaces. */
export function PierreCodeProvider({ children }: { children: ReactNode }) {
  const theme = useCodeTheme()
  const options = useMemo(() => ({ ...highlighterOptions, theme }), [theme])
  return (
    <WorkerPoolContextProvider poolOptions={poolOptions} highlighterOptions={options}>
      <CodeAppearanceSync theme={theme} />
      {children}
    </WorkerPoolContextProvider>
  )
}
