import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { createSettingsDeviceApi } from '@/components/settings/settings-cloud-api'
import { gitRepositoryDomain, needsGitConfiguration, parseGitAccessFailure } from '@/lib/git-access'
import type { GitAccessFailure } from '@/lib/git-access'
import type { CloneGitRepositoryInput, DeviceInfo } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import { logRuntimeTaskCreateStage } from '@/lib/runtime-create-diagnostics'
import { gitCloneFailureReason, type GitCloneFailureReason } from './gitCloneProjectRecovery'

interface CloneOperation extends CloneGitRepositoryInput {
  deviceId: string
  name: string
  cloudAccountKey: string
  status: 'checking' | 'syncing' | 'cloning' | 'opening' | 'waiting-configuration' | 'failed'
  failureStage?: 'clone' | 'open'
  failureReason?: GitCloneFailureReason
  error?: string
  gitFailure?: GitAccessFailure
}

interface Options {
  device: DeviceInfo | null
  clone?: (deviceId: string, input: CloneGitRepositoryInput) => Promise<void>
  open?: (deviceId: string, path: string, name: string) => Promise<void> | void
  refreshDevices?: () => Promise<void>
}

export function useGitCloneProject({ device, clone, open, refreshDevices }: Options) {
  const cloud = useOptionalCloudConnection()
  const { t } = useTranslation('common')
  const [operation, setOperation] = useState<CloneOperation | null>(null)
  const active = useRef<CloneOperation | null>(null)
  const running = useRef(false)
  const latestCloud = useRef(cloud)
  useLayoutEffect(() => {
    latestCloud.current = cloud
  }, [cloud])
  useEffect(
    () => () => {
      active.current = null
    },
    []
  )

  const reset = useCallback(() => {
    if (running.current) return
    active.current = null
    setOperation(null)
  }, [])

  async function submit(input: CloneGitRepositoryInput): Promise<boolean> {
    if (!device || !clone || !open || running.current) return false
    running.current = true
    const previous = active.current
    const sameInput =
      previous?.deviceId === device.device_id &&
      previous.url === input.url &&
      previous.branch === input.branch &&
      previous.targetPath === input.targetPath
    const attempt: CloneOperation = sameInput
      ? { ...previous }
      : {
          ...input,
          deviceId: device.device_id,
          name: input.targetPath.split(/[\\/]/).filter(Boolean).at(-1) || 'repository',
          cloudAccountKey: `${cloud.backendUrl ?? ''}:${cloud.user?.id ?? ''}`,
          status: 'checking',
        }
    active.current = attempt
    const update = (patch: Partial<CloneOperation>) => {
      if (active.current !== attempt) return
      Object.assign(attempt, patch)
      setOperation({ ...attempt })
    }
    const managed = managedDevice(device)
    const originalCloud = () =>
      latestCloud.current.isConnected &&
      `${latestCloud.current.backendUrl ?? ''}:${latestCloud.current.user?.id ?? ''}` ===
        attempt.cloudAccountKey
    async function syncAccounts(required: boolean) {
      if (!managed || active.current !== attempt) return false
      if (!originalCloud()) {
        if (required) throw new Error(t('workbench.git_access_reconnect_original'))
        return false
      }
      const api = createSettingsDeviceApi(latestCloud.current)
      const domain = gitRepositoryDomain(input.url)
      const summary = await api.getGitAccountSyncSummary()
      if (active.current !== attempt) return false
      if (!originalCloud()) throw new Error(t('workbench.git_access_account_changed'))
      const hasAccount = summary.accounts.some(
        account => account.effective && account.domain.toLowerCase() === domain
      )
      if (!hasAccount) {
        if (required)
          throw new Error(
            `git-access:${JSON.stringify({
              code: 'credentials-required',
              domain,
              message: t('workbench.git_access_missing_domain', { domain }),
            })}`
          )
        return false
      }
      update({ status: 'syncing' })
      await api.syncGitAccounts(attempt.deviceId, false)
      if (!originalCloud()) throw new Error(t('workbench.git_access_account_changed'))
      return true
    }

    let stage: 'clone' | 'open' = sameInput && previous.failureStage === 'open' ? 'open' : 'clone'
    const configured = sameInput && previous.status === 'waiting-configuration'
    update({ status: stage === 'open' ? 'opening' : 'checking', error: undefined })
    logRuntimeTaskCreateStage('git-project-operation-started', {
      deviceId: attempt.deviceId,
      targetPath: attempt.targetPath,
      operationStage: stage,
    })
    try {
      if (attempt.failureReason === 'executor-offline') await refreshDevices?.()
      if (active.current !== attempt) return false
      if (stage === 'clone') {
        if (configured) await syncAccounts(true)
        if (active.current !== attempt) return false
        update({ status: 'cloning', gitFailure: undefined })
        try {
          // The executor checks repository access before cloning. Public and native
          // repositories must not depend on cloud account configuration.
          await clone(attempt.deviceId, input)
        } catch (error) {
          const failure = parseGitAccessFailure(error)
          update({ gitFailure: failure })
          if (configured || !needsGitConfiguration(failure) || !(await syncAccounts(false)))
            throw error
          if (active.current !== attempt) return false
          update({ status: 'cloning', gitFailure: undefined })
          // Credential sync is not proof of access; revalidate once, without looping.
          await clone(attempt.deviceId, input)
        }
        stage = 'open'
        update({ status: 'opening', gitFailure: undefined })
      }
      if (active.current !== attempt) return false
      await open(attempt.deviceId, attempt.targetPath, attempt.name)
      if (active.current !== attempt) return false
      active.current = null
      setOperation(null)
      return true
    } catch (error) {
      const failure = parseGitAccessFailure(error)
      const gitFailure = failure ?? attempt.gitFailure
      const failureReason = gitCloneFailureReason(error, stage)
      logRuntimeTaskCreateStage('git-project-operation-failed', {
        operationStage: stage,
        deviceId: attempt.deviceId,
        targetPath: attempt.targetPath,
        failureReason,
      })
      update({
        status: needsGitConfiguration(gitFailure) ? 'waiting-configuration' : 'failed',
        failureStage: stage,
        failureReason,
        gitFailure,
        error: failure?.message ?? (error instanceof Error ? error.message : String(error)),
      })
      return false
    } finally {
      running.current = false
    }
  }

  const currentOperation = !device || operation?.deviceId === device.device_id ? operation : null
  return {
    operation: currentOperation,
    deviceRecovery: operation?.failureReason === 'executor-not-found',
    submitting: Boolean(
      currentOperation && !['failed', 'waiting-configuration'].includes(currentOperation.status)
    ),
    canConfigure:
      managedDevice(device) &&
      cloud.isConnected &&
      (!currentOperation ||
        currentOperation.cloudAccountKey === `${cloud.backendUrl ?? ''}:${cloud.user?.id ?? ''}`),
    submit,
    reset,
  }
}

function managedDevice(device: DeviceInfo | null) {
  return (
    device !== null &&
    (device.device_type === 'cloud' || device.device_type === 'remote') &&
    device.bind_shell === 'claudecode'
  )
}
