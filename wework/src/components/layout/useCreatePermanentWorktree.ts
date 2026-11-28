import { useCallback } from 'react'
import type { WorkbenchContextValue } from '@/features/workbench/workbenchContextTypes'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'

function getPermanentWorktreeError(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) return error.message
  if (error && typeof error === 'object' && 'message' in error) {
    const message = String(error.message).trim()
    if (message) return message
  }
  return fallback
}

export function useCreatePermanentWorktree(
  runtimeWorkApi: WorkbenchServices['runtimeWorkApi'],
  openStandaloneWorkspace: WorkbenchContextValue['openStandaloneWorkspace'],
  captureOwner?: () => { isCurrent(): boolean }
) {
  const { t } = useTranslation('common')

  return useCallback(
    async ({
      deviceId,
      sourcePath,
      name,
    }: {
      deviceId: string
      sourcePath: string
      name: string
    }) => {
      const scope = captureOwner?.()
      if (!runtimeWorkApi) {
        throw new Error(t('workbench.create_permanent_worktree_unavailable'))
      }
      let prepared
      try {
        prepared = await runtimeWorkApi.prepareWorktree({
          deviceId,
          sourcePath,
          worktreeId: `permanent-${crypto.randomUUID()}`,
          permanent: true,
        })
      } catch (error) {
        throw new Error(
          getPermanentWorktreeError(error, t('workbench.create_permanent_worktree_failed')),
          { cause: error }
        )
      }
      if (scope && !scope.isCurrent()) return
      const workspacePath = prepared.path ?? prepared.worktree.path
      try {
        await openStandaloneWorkspace(deviceId, workspacePath, name)
      } catch (error) {
        await runtimeWorkApi
          .deleteWorktree({ deviceId, path: workspacePath, preserveSnapshot: false })
          .catch(() => undefined)
        throw error
      }
    },
    [captureOwner, openStandaloneWorkspace, runtimeWorkApi, t]
  )
}
