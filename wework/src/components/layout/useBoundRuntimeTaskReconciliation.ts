import { useEffect } from 'react'
import type { RuntimeTaskAddress } from '@/types/api'

function hasResolvedExecutionAddress(current: RuntimeTaskAddress, resolved: RuntimeTaskAddress) {
  return (
    current.deviceId === resolved.deviceId &&
    current.taskId === resolved.taskId &&
    current.runtime === resolved.runtime &&
    current.threadId === resolved.threadId &&
    current.workspacePath === resolved.workspacePath &&
    current.workspaceKind === resolved.workspaceKind &&
    current.worktreeId === resolved.worktreeId &&
    JSON.stringify(current.runtimeHandle?.modelSelection ?? null) ===
      JSON.stringify(resolved.runtimeHandle?.modelSelection ?? null)
  )
}

export function useBoundRuntimeTaskReconciliation(
  active: boolean,
  current: RuntimeTaskAddress | null | undefined,
  resolved: RuntimeTaskAddress | null | undefined,
  openTask: (address: RuntimeTaskAddress) => Promise<unknown>
) {
  useEffect(() => {
    if (!active || !current || !resolved || hasResolvedExecutionAddress(current, resolved)) return
    void openTask(resolved)
  }, [active, current, resolved, openTask])
}
