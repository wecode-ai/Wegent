import { useEffect } from 'react'
import type { RuntimeTaskAddress } from '@/types/api'
import { reportE2EDiagnostic } from '@/e2e/error-capture'

const ADDRESS_FIELDS = [
  'deviceId',
  'taskId',
  'runtime',
  'threadId',
  'workspacePath',
  'workspaceKind',
  'worktreeId',
] as const

function executionAddressDifferences(
  current: RuntimeTaskAddress,
  resolved: RuntimeTaskAddress
): string[] {
  const changed: string[] = ADDRESS_FIELDS.filter(field => current[field] !== resolved[field])
  if (
    JSON.stringify(current.runtimeHandle?.modelSelection ?? null) !==
    JSON.stringify(resolved.runtimeHandle?.modelSelection ?? null)
  )
    changed.push('modelSelection')
  return changed
}

export function useBoundRuntimeTaskReconciliation(
  active: boolean,
  current: RuntimeTaskAddress | null | undefined,
  resolved: RuntimeTaskAddress | null | undefined,
  openTask: (address: RuntimeTaskAddress) => Promise<unknown>
) {
  useEffect(() => {
    if (!active || !current || !resolved) return
    const changedFields = executionAddressDifferences(current, resolved)
    if (!changedFields.length) return
    if (import.meta.env.VITE_WEWORK_E2E === 'true') {
      reportE2EDiagnostic('bound-task-execution-address-reconciliation', {
        current: Object.fromEntries(ADDRESS_FIELDS.map(field => [field, current[field] ?? null])),
        resolved: Object.fromEntries(ADDRESS_FIELDS.map(field => [field, resolved[field] ?? null])),
        changedFields,
      })
    }
    void openTask(resolved)
  }, [active, current, resolved, openTask])
}
