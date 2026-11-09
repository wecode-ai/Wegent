import { useEffect, useId, useState } from 'react'
import { FolderOpen, Loader2 } from 'lucide-react'
import {
  GitAccountConfigurationButton,
  GitAccountConfigurationProvider,
} from '@wegent/collaboration/controls'
import { createCollaborationTranslator } from '@wegent/collaboration'
import { useTranslation } from '@/hooks/useTranslation'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { hasEmbeddedHttpGitCredentials } from '@/lib/git-url'
import { gitRepositoryDomain } from '@/lib/git-access'
import { openExternalUrl } from '@/lib/external-links'
import type { CloneGitRepositoryInput, DeviceInfo } from '@/types/api'
import { DeviceFolderPicker } from './DeviceFolderPicker'
import { joinPath } from './device-folder-path'
import { useGitCloneProject } from './useGitCloneProject'

interface Props {
  device: DeviceInfo | null
  onGetDeviceHomeDirectory: (deviceId: string) => Promise<string>
  onListDeviceDirectories: (deviceId: string, path: string) => Promise<string[]>
  onCreateDeviceDirectory: (deviceId: string, path: string) => Promise<void>
  onCloneGitRepository?: (deviceId: string, input: CloneGitRepositoryInput) => Promise<void>
  onOpenStandaloneWorkspace?: (deviceId: string, path: string, name: string) => Promise<void> | void
  onRefreshDevices?: () => Promise<void>
  onReselectDevice?: () => Promise<void>
  onSubmittingChange: (pending: boolean) => void
  onClose: () => void
}

export function StandaloneGitProjectForm({
  device,
  onGetDeviceHomeDirectory,
  onListDeviceDirectories,
  onCreateDeviceDirectory,
  onCloneGitRepository,
  onOpenStandaloneWorkspace,
  onRefreshDevices,
  onReselectDevice,
  onSubmittingChange,
  onClose,
}: Props) {
  const { t, i18n } = useTranslation('common')
  const cloud = useOptionalCloudConnection()
  const gitUrlId = useId()
  const [url, setUrl] = useState('')
  const [branch, setBranch] = useState('')
  const deviceId = device?.device_id ?? ''
  const [directory, setDirectory] = useState({ deviceId, path: '' })
  const [picker, setPicker] = useState({ deviceId, open: false })
  if (picker.deviceId !== deviceId) setPicker({ deviceId, open: false })
  const pickerOpen = picker.deviceId === deviceId && picker.open
  const setPickerOpen = (open: boolean) => setPicker({ deviceId, open })
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [validationError, setValidationError] = useState<{
    deviceId: string
    message: string
  } | null>(null)
  const error = validationError?.deviceId === deviceId ? validationError.message : null
  const setError = (message: string | null) =>
    setValidationError(message === null ? null : { deviceId, message })
  const { operation, deviceRecovery, submitting, canConfigure, submit, reset } = useGitCloneProject(
    {
      device,
      clone: onCloneGitRepository,
      open: onOpenStandaloneWorkspace,
      refreshDevices: onRefreshDevices,
    }
  )
  const parentPath =
    directory.deviceId === deviceId || deviceRecovery || !device ? directory.path : ''
  const setParentPath = (path: string) => setDirectory({ deviceId, path })
  useEffect(() => {
    onSubmittingChange(submitting)
  }, [onSubmittingChange, submitting])
  useEffect(() => {
    let cancelled = false
    if (!deviceId) return
    onGetDeviceHomeDirectory(deviceId)
      .then(path => {
        if (!cancelled)
          setDirectory(current =>
            current.path && (current.deviceId === deviceId || deviceRecovery)
              ? { deviceId, path: current.path }
              : { deviceId, path }
          )
      })
      .catch(error => {
        if (!cancelled)
          setValidationError({
            deviceId,
            message: error instanceof Error ? error.message : String(error),
          })
      })
    return () => {
      cancelled = true
    }
  }, [deviceId, deviceRecovery, onGetDeviceHomeDirectory])

  const repositoryName = getGitRepositoryName(url)
  const domain = gitRepositoryDomain(url)
  const waiting = operation?.status === 'waiting-configuration'
  const failure = operation?.gitFailure
  const accessError = failure
    ? t(`workbench.git_access_${failure.code.replaceAll('-', '_')}`, { domain: failure.domain })
    : operation?.error
  const updateInput = (update: () => void) => {
    update()
    setError(null)
    reset()
  }
  async function submitProject() {
    if (submitting) return
    const normalizedUrl = url.trim()
    if (!repositoryName || !isValidGitRepositoryUrl(normalizedUrl)) {
      setError(t('workbench.remote_project_git_url_invalid'))
      return
    }
    if (hasEmbeddedHttpGitCredentials(normalizedUrl)) {
      setError(t('workbench.remote_project_git_credentials_forbidden'))
      return
    }
    if (!parentPath.trim()) {
      setError(t('workbench.remote_project_git_parent_required'))
      return
    }
    setError(null)
    if (
      await submit({
        url: normalizedUrl,
        ...(branch.trim() ? { branch: branch.trim() } : {}),
        targetPath: joinPath(parentPath.trim(), repositoryName),
      })
    )
      onClose()
  }

  if (pickerOpen && device)
    return (
      <div className="mt-3">
        <h3 className="mb-2 text-sm font-medium text-text-primary">
          {t('workbench.remote_project_git_parent_select')}
        </h3>
        <DeviceFolderPicker
          device={device}
          mode="select"
          variant="remote"
          initialPath={parentPath}
          confirmLabel={t('workbench.remote_project_git_parent_confirm')}
          onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
          onListDeviceDirectories={onListDeviceDirectories}
          onCreateDeviceDirectory={onCreateDeviceDirectory}
          onCancel={() => setPickerOpen(false)}
          onConfirm={result => {
            updateInput(() => setParentPath(result.path))
            setPickerOpen(false)
          }}
        />
      </div>
    )

  return (
    <div data-testid="remote-project-git-form">
      <div className="mt-3">
        <div
          className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"
          data-testid="remote-project-git-url-heading"
        >
          <label htmlFor={gitUrlId} className="text-sm font-medium text-text-primary">
            {t('workbench.remote_project_git_url')}
          </label>
          <div className="ml-auto flex flex-col items-end">
            <GitAccountConfigurationProvider
              value={
                canConfigure && !submitting && (!url.trim() || /^https?:\/\//i.test(url.trim()))
                  ? {
                      baseUrl: cloud.webUrl,
                      openUrl: value => openExternalUrl(value, { source: 'git-clone-recovery' }),
                    }
                  : null
              }
            >
              <GitAccountConfigurationButton
                appearance="text"
                failure={failure ?? { code: 'credentials-required', domain, message: '' }}
                translate={createCollaborationTranslator(
                  i18n.language.startsWith('zh') ? 'zh-CN' : 'en'
                )}
                testId="remote-project-git-configure"
              />
            </GitAccountConfigurationProvider>
          </div>
        </div>
        <input
          id={gitUrlId}
          data-testid="remote-project-git-url-input"
          value={url}
          autoFocus
          disabled={submitting}
          onChange={event => updateInput(() => setUrl(event.target.value))}
          placeholder="https://github.com/owner/repository.git"
          className="mt-2 h-11 w-full rounded-[10px] border border-border bg-background px-3 text-sm text-text-primary outline-none keyboard:focus:border-focus keyboard:focus:ring-2 keyboard:focus:ring-focus/20 disabled:opacity-60 sm:h-10"
        />
      </div>
      <label className="mt-4 block">
        <span className="text-sm font-medium text-text-primary">
          {t('workbench.remote_project_git_parent')}
        </span>
        <span className="mt-2 flex gap-2">
          <input
            id="remote-project-git-parent-input"
            data-testid="remote-project-git-parent-input"
            value={parentPath}
            disabled={submitting}
            onChange={event => updateInput(() => setParentPath(event.target.value))}
            className="h-11 min-w-0 flex-1 rounded-[10px] border border-border bg-background px-3 font-mono text-sm text-text-primary outline-none keyboard:focus:border-focus keyboard:focus:ring-2 keyboard:focus:ring-focus/20 disabled:opacity-60 sm:h-10"
          />
          <button
            type="button"
            data-testid="remote-project-git-parent-browse"
            disabled={submitting || !device}
            onClick={() => setPickerOpen(true)}
            className="inline-flex h-11 shrink-0 items-center gap-2 rounded-[10px] border border-border px-3 text-sm text-text-primary hover:bg-muted disabled:opacity-50 sm:h-10"
          >
            <FolderOpen className="h-4 w-4" />
            {t('workbench.remote_project_git_parent_browse')}
          </button>
        </span>
      </label>
      {repositoryName && parentPath.trim() && (
        <p
          data-testid="remote-project-git-target-preview"
          className="mt-2 truncate font-mono text-xs text-text-secondary"
        >
          {joinPath(parentPath.trim(), repositoryName)}
        </p>
      )}
      <button
        type="button"
        data-testid="remote-project-git-advanced-toggle"
        disabled={submitting}
        onClick={() => setAdvancedOpen(value => !value)}
        className="mt-4 h-11 text-sm text-text-secondary hover:text-text-primary disabled:opacity-50 sm:h-8"
      >
        {t(
          advancedOpen
            ? 'workbench.remote_project_git_advanced_hide'
            : 'workbench.remote_project_git_advanced_show'
        )}
      </button>
      {advancedOpen && (
        <label className="mt-2 block">
          <span className="sr-only">{t('workbench.remote_project_git_branch')}</span>
          <input
            data-testid="remote-project-git-branch-input"
            value={branch}
            disabled={submitting}
            onChange={event => updateInput(() => setBranch(event.target.value))}
            placeholder={t('workbench.remote_project_git_branch_placeholder')}
            className="h-11 w-full rounded-[10px] border border-border bg-background px-3 text-sm text-text-primary outline-none keyboard:focus:border-focus keyboard:focus:ring-2 keyboard:focus:ring-focus/20 disabled:opacity-60 sm:h-10"
          />
        </label>
      )}
      {(error || accessError) && (
        <div
          role="alert"
          className="mt-3 space-y-1 text-sm text-error"
          data-testid="remote-project-git-error"
        >
          <p>{error || accessError}</p>
          {!error && failure && operation?.error !== failure.message && <p>{operation?.error}</p>}
        </div>
      )}
      {(deviceRecovery || !device) && (
        <div className="mt-2 text-sm text-text-secondary">
          <p>{t('workbench.remote_project_device_unavailable')}</p>
          {onReselectDevice && (
            <button
              type="button"
              data-testid="remote-project-git-reselect-device"
              disabled={submitting}
              onClick={() => void onReselectDevice().catch(error => setError(String(error)))}
              className="min-h-11 text-sm hover:text-text-primary sm:min-h-8"
            >
              {t('workbench.reselect_device')}
            </button>
          )}
        </div>
      )}
      {waiting && (
        <p className="mt-2 text-xs text-text-secondary">
          {t(
            device?.device_type === 'local'
              ? 'workbench.git_access_local_hint'
              : 'workbench.git_access_managed_hint',
            {
              device: device?.name || deviceId,
            }
          )}
          {!canConfigure &&
            device?.device_type !== 'local' &&
            ` ${t('workbench.git_access_reconnect_original')}`}
        </p>
      )}
      <div className="mt-5 flex items-center justify-end gap-2">
        {submitting && (
          <span
            role="status"
            data-testid="remote-project-git-status"
            className="mr-auto text-xs text-text-secondary"
          >
            {t(
              operation?.status === 'syncing'
                ? 'workbench.git_access_syncing'
                : operation?.status === 'opening'
                  ? 'workbench.remote_project_git_opening'
                  : operation?.status === 'cloning'
                    ? 'workbench.remote_project_git_cloning'
                    : 'workbench.git_access_checking'
            )}
          </span>
        )}
        <button
          type="button"
          data-testid="remote-project-git-cancel"
          disabled={submitting}
          onClick={onClose}
          className="h-11 rounded-[10px] px-4 text-sm font-medium text-text-secondary hover:bg-muted disabled:opacity-50 sm:h-9"
        >
          {t('workbench.cancel')}
        </button>
        <button
          type="button"
          data-testid="remote-project-git-submit"
          disabled={
            submitting ||
            !url.trim() ||
            !parentPath.trim() ||
            !repositoryName ||
            !onCloneGitRepository ||
            !onOpenStandaloneWorkspace ||
            !device
          }
          onClick={() => void submitProject()}
          className="inline-flex h-11 items-center gap-2 rounded-[10px] bg-text-primary px-4 text-sm font-medium text-background hover:bg-text-primary/90 disabled:opacity-50 sm:h-9"
        >
          {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
          {t(
            waiting
              ? device?.device_type === 'local'
                ? 'workbench.git_access_recheck'
                : 'workbench.git_access_sync_resume'
              : operation?.failureStage === 'open'
                ? 'workbench.retry'
                : 'workbench.remote_project_git_submit'
          )}
        </button>
      </div>
    </div>
  )
}

function getGitRepositoryName(url: string): string {
  return (
    url
      .trim()
      .replace(/\/+$/, '')
      .split(/[/:]/)
      .filter(Boolean)
      .at(-1)
      ?.replace(/\.git$/i, '') ?? ''
  )
}

function isValidGitRepositoryUrl(value: string): boolean {
  if (/^(?:\/|[A-Za-z]:[\\/])/.test(value) || /^[^@\s]+@[^:\s]+:.+/.test(value)) return true
  try {
    return ['http:', 'https:', 'ssh:', 'git:', 'file:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}
