import { useEffect, useState } from 'react'
import type { RuntimeWorkListResponse } from '@wegent/chat-core/runtime-task-api-types'
import type { SharedWorkspaceRuntimeApi, WorkspaceTaskBinding } from '../ports/SharedWorkspaceApi'

export function useBrowserBoardRuntimeWork(
  runtime: SharedWorkspaceRuntimeApi | undefined,
  bindings: WorkspaceTaskBinding[]
) {
  const [result, setResult] = useState<{
    runtime: SharedWorkspaceRuntimeApi
    work: RuntimeWorkListResponse | null
    error: string | null
  } | null>(null)
  useEffect(() => {
    if (!runtime || !bindings.length) return
    const controller = new AbortController()
    void runtime.work
      .listRuntimeWork({ signal: controller.signal })
      .then(work => {
        if (!controller.signal.aborted) setResult({ runtime, work, error: null })
      })
      .catch(cause => {
        if (!controller.signal.aborted)
          setResult({
            runtime,
            work: null,
            error: cause instanceof Error ? cause.message : String(cause),
          })
      })
    return () => controller.abort()
  }, [runtime, bindings])
  return result?.runtime === runtime ? result : null
}
