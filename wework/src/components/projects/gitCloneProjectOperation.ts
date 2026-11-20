import { createSettingsDeviceApi } from '@/components/settings/settings-cloud-api'
import { gitRepositoryDomain, needsGitConfiguration, parseGitAccessFailure } from '@/lib/git-access'
import type { GitAccessFailure } from '@/lib/git-access'
import type { CloneGitRepositoryInput, DeviceInfo } from '@/types/api'
import type { useTranslation } from '@/hooks/useTranslation'
import type { CloudConnectionContextValue } from '@/features/cloud-connection/CloudConnectionContext'
import { logRuntimeTaskCreateStage } from '@/lib/runtime-create-diagnostics'
import { gitCloneFailureReason, type GitCloneFailureReason } from './gitCloneProjectRecovery'

export interface CloneOperation extends CloneGitRepositoryInput {
  deviceId: string
  name: string
  cloudAccountKey: string
  status: 'checking' | 'syncing' | 'cloning' | 'opening' | 'waiting-configuration' | 'failed'
  failureStage?: 'clone' | 'open'
  failureReason?: GitCloneFailureReason
  error?: string
  gitFailure?: GitAccessFailure
}

export interface GitCloneProjectOptions {
  device: DeviceInfo | null
  clone?: (deviceId: string, input: CloneGitRepositoryInput) => Promise<void>
  open?: (deviceId: string, path: string, name: string) => Promise<void> | void
  refreshDevices?: () => Promise<void>
  onSubmittingChange?: (pending: boolean) => void
}

type OperationSource = GitCloneProjectOptions & {
  cloud: CloudConnectionContextValue
  readCloud: () => CloudConnectionContextValue
  translate: ReturnType<typeof useTranslation>['t']
}

/** One observed Git operation owns its lock, recovery data and account identity. */
export function createGitCloneProjectOperation() {
  const bindings = new Map<symbol, () => void>()
  let snapshot: CloneOperation | null = null
  let active: CloneOperation | null = null
  let running = false
  let detachRevision = 0
  const publish = (value: CloneOperation | null) => {
    snapshot = value
    for (const listener of [...bindings.values()]) listener()
  }
  const isCurrent = (attempt: CloneOperation) => active === attempt && bindings.size > 0
  const reset = () => {
    if (running) return
    active = null
    publish(null)
  }

  async function submit(input: CloneGitRepositoryInput, config: OperationSource): Promise<boolean> {
    if (!bindings.size || !config.device || !config.clone || !config.open || running) return false
    const {
      device,
      clone,
      open,
      refreshDevices,
      cloud,
      readCloud,
      translate: t,
      onSubmittingChange,
    } = config
    running = true
    const previous = active
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
    active = attempt
    const update = (patch: Partial<CloneOperation>) => {
      if (!isCurrent(attempt)) return
      Object.assign(attempt, patch)
      publish({ ...attempt })
    }
    const managed = managedDevice(device)
    const originalCloud = () => {
      const current = readCloud()
      return Boolean(
        current?.isConnected &&
        `${current.backendUrl ?? ''}:${current.user?.id ?? ''}` === attempt.cloudAccountKey
      )
    }
    async function syncAccounts(required: boolean) {
      if (!managed || !isCurrent(attempt)) return false
      if (!originalCloud()) {
        if (required) throw new Error(t('workbench.git_access_reconnect_original'))
        return false
      }
      const api = createSettingsDeviceApi(readCloud())
      const domain = gitRepositoryDomain(input.url)
      const summary = await api.getGitAccountSyncSummary()
      if (!isCurrent(attempt)) return false
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
      onSubmittingChange?.(true)
      if (attempt.failureReason === 'executor-offline') await refreshDevices?.()
      if (!isCurrent(attempt)) return false
      if (stage === 'clone') {
        if (configured) await syncAccounts(true)
        if (!isCurrent(attempt)) return false
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
          if (!isCurrent(attempt)) return false
          update({ status: 'cloning', gitFailure: undefined })
          // Credential sync is not proof of access; revalidate once, without looping.
          await clone(attempt.deviceId, input)
        }
        stage = 'open'
        update({ status: 'opening', gitFailure: undefined })
      }
      if (!isCurrent(attempt)) return false
      await open(attempt.deviceId, attempt.targetPath, attempt.name)
      if (!isCurrent(attempt)) return false
      active = null
      publish(null)
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
      running = false
      if (bindings.size) onSubmittingChange?.(false)
    }
  }

  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => null,
    subscribe(listener: () => void) {
      const token = Symbol('git-clone')
      bindings.set(token, listener)
      detachRevision++
      return () => {
        bindings.delete(token)
        if (!bindings.size) {
          const revision = ++detachRevision
          // Subscription replacement and StrictMode replay share the same committed operation.
          queueMicrotask(() => {
            if (!bindings.size && revision === detachRevision) {
              active = null
              snapshot = null
            }
          })
        }
      }
    },
    submit,
    reset,
  }
}

export function managedDevice(device: DeviceInfo | null) {
  return (
    device !== null &&
    (device.device_type === 'cloud' || device.device_type === 'remote') &&
    device.bind_shell === 'claudecode'
  )
}
