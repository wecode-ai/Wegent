import { WorkerPoolContextProvider } from '@pierre/diffs/react'
import DiffWorker from '@pierre/diffs/worker/worker.js?worker'
import type { ReactNode } from 'react'

const poolOptions = {
  workerFactory: () => new DiffWorker(),
  poolSize: 4,
  totalASTLRUCacheSize: 100,
}

const highlighterOptions = {
  preferredHighlighter: 'highlights' as const,
  theme: { dark: 'pierre-dark', light: 'pierre-light' },
  useTokenTransformer: true,
  langs: ['typescript', 'javascript', 'css', 'html', 'python'],
  lineDiffType: 'word-alt' as const,
}

/** Pierre shares this pool across mounted code surfaces. */
export function PierreCodeProvider({ children }: { children: ReactNode }) {
  return (
    <WorkerPoolContextProvider poolOptions={poolOptions} highlighterOptions={highlighterOptions}>
      {children}
    </WorkerPoolContextProvider>
  )
}
