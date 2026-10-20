import { StandInIcon } from './StandInIcon'
import * as Popover from '@radix-ui/react-popover'
import { Monitor, X } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type {
  CollaborationProject,
  SharedWorkspaceApi,
  WorkspaceStandInSettings,
  WorkspaceProjectAgent,
} from '@wegent/collaboration'
import { useTranslation } from '@/hooks/useTranslation'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { DeviceInfo } from '@/types/api'

const emptySettings: WorkspaceStandInSettings = {
  enabled: false,
  prompt: '',
  executionDeviceId: '',
  version: 0,
}

export function StandInPopover({
  api,
  project,
  devices = [],
  readLocalIdentity,
}: {
  api: SharedWorkspaceApi
  project: CollaborationProject
  devices?: DeviceInfo[]
  readLocalIdentity?: WorkbenchServices['getLocalRuntimeSidebarIdentity']
}) {
  const { t } = useTranslation('common')
  const promptId = useId()
  const titleId = useId()
  const [open, setOpen] = useState(false)
  const [saved, setSaved] = useState(emptySettings)
  const [draft, setDraft] = useState(emptySettings)
  const deviceLoad = useRef(0)
  const selectedDevice = useRef('')
  const [currentDeviceId, setCurrentDeviceId] = useState('')
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [agents, setAgents] = useState<WorkspaceProjectAgent[]>([])
  const [agentError, setAgentError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const canConfigure =
    project.project_store === 'local' ||
    ['Developer', 'Maintainer', 'Owner'].includes(project.access_role ?? '')
  const load = useCallback(
    (signal: { cancelled: boolean }) => {
      if (!api.standIn) return Promise.resolve()
      let current = ''
      return (readLocalIdentity?.() ?? Promise.resolve(null))
        .then(identity => {
          if (signal.cancelled) return null
          current = identity?.deviceId ?? ''
          setCurrentDeviceId(current)
          selectedDevice.current ||= current
          return api.standIn!.get(project.id, selectedDevice.current || undefined)
        })
        .then(settings => {
          if (signal.cancelled || !settings) return
          setError(null)
          setSaved(settings)
          setLoaded(true)
          setDraft({ ...settings, executionDeviceId: settings.executionDeviceId || current })
        })
        .catch((cause: unknown) => {
          if (!signal.cancelled) setError(cause instanceof Error ? cause.message : String(cause))
        })
        .finally(() => {
          if (!signal.cancelled) setLoading(false)
        })
    },
    [api, project.id, readLocalIdentity]
  )
  useEffect(() => {
    const signal = { cancelled: false }
    void load(signal)
    return () => {
      signal.cancelled = true
    }
  }, [load, open])

  useEffect(() => {
    if (!open || !api.agents) return
    let cancelled = false
    void api.agents
      .list(project.id)
      .then(rows => {
        if (!cancelled) {
          setAgents(
            rows.filter(
              agent =>
                agent.status !== 'archived' && agent.canUse !== false && agent.can_use !== false
            )
          )
          setAgentError(null)
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) setAgentError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [api.agents, project.id, open])

  const selectDevice = async (deviceId: string) => {
    selectedDevice.current = deviceId
    const revision = ++deviceLoad.current
    setDraft({ ...emptySettings, executionDeviceId: deviceId })
    setLoaded(false)
    setError(null)
    try {
      const settings = await api.standIn!.get(project.id, deviceId)
      if (revision !== deviceLoad.current) return
      setSaved(settings)
      setDraft({ ...settings, executionDeviceId: deviceId })
      setLoaded(true)
    } catch (cause) {
      if (revision === deviceLoad.current)
        setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  if (!api.standIn) return null
  const availableDevices: Pick<DeviceInfo, 'device_id' | 'app_device_id' | 'name' | 'status'>[] =
    devices.filter(
      device =>
        project.project_store !== 'local' ||
        [device.device_id, device.app_device_id].includes(currentDeviceId)
    )
  if (
    currentDeviceId &&
    !availableDevices.some(device =>
      [device.device_id, device.app_device_id].includes(currentDeviceId)
    )
  ) {
    availableDevices.unshift({
      device_id: currentDeviceId,
      name: t('standIn.current_device'),
      status: 'online',
    })
  }
  const selectionMissing = Boolean(
    draft.executionDeviceId &&
    !availableDevices.some(device =>
      [device.device_id, device.app_device_id].includes(draft.executionDeviceId)
    )
  )
  const save = async () => {
    if (!api.standIn || !loaded || loading || saving || !canConfigure) return
    setSaving(true)
    setError(null)
    try {
      const result = await api.standIn.save(project.id, draft)
      setSaved(result)
      setOpen(false)
      setNotice(t('standIn.saved'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Popover.Root
      open={open}
      onOpenChange={next => {
        if (!saving) {
          deviceLoad.current += 1
          setOpen(next)
          setNotice(null)
          if (next) {
            setLoading(true)
            setLoaded(false)
            setError(null)
          }
        }
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          data-testid="stand-in-open"
          aria-label={t('standIn.title')}
          title={t(saved.enabled ? 'standIn.enabled' : 'standIn.title')}
          className="relative inline-flex h-8 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-text-primary hover:bg-muted"
        >
          <StandInIcon enabled={open ? draft.enabled : saved.enabled} />
          {saved.enabled && (
            <span
              data-testid="stand-in-enabled"
              className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-text-primary"
            />
          )}
        </button>
      </Popover.Trigger>
      {notice && (
        <span role="status" className="text-xs text-text-muted">
          {notice}
        </span>
      )}
      <Popover.Portal>
        <Popover.Content
          aria-labelledby={titleId}
          align="start"
          sideOffset={8}
          collisionPadding={12}
          className="z-50 w-[370px] max-w-[calc(100vw-24px)] rounded-xl border border-border bg-background text-sm text-text-primary shadow-lg"
          data-testid="stand-in-settings"
          onEscapeKeyDown={event => {
            if (saving) event.preventDefault()
          }}
          onInteractOutside={event => {
            if (saving) event.preventDefault()
          }}
        >
          <div className="flex items-start gap-3 border-b border-border p-4">
            <StandInIcon enabled={draft.enabled} />
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="font-semibold">
                {t('standIn.title')}
              </h2>
              <p className="mt-1 text-xs text-text-muted">{project.name}</p>
            </div>
            <Popover.Close asChild>
              <button
                type="button"
                disabled={saving}
                data-testid="stand-in-close"
                aria-label={t('standIn.close')}
                className="rounded p-0.5 text-text-muted hover:bg-muted"
              >
                <X className="h-4 w-4" />
              </button>
            </Popover.Close>
          </div>
          <div className="p-4">
            <p className="mb-4 leading-relaxed text-text-secondary">{t('standIn.description')}</p>
            {loading ? (
              <p role="status" className="text-text-muted">
                {t('standIn.loading')}
              </p>
            ) : (
              <>
                <div className="mb-6 flex items-center justify-between gap-4">
                  <span id={`${titleId}-auto`}>{t('standIn.auto')}</span>
                  <button
                    type="button"
                    role="switch"
                    aria-labelledby={`${titleId}-auto`}
                    aria-checked={draft.enabled}
                    disabled={!canConfigure || saving || !loaded}
                    data-testid="stand-in-auto"
                    onClick={() => setDraft(current => ({ ...current, enabled: !current.enabled }))}
                    className={`inline-flex h-6 w-11 shrink-0 rounded-full p-0.5 transition disabled:opacity-50 ${draft.enabled ? 'bg-text-primary' : 'bg-border'}`}
                  >
                    <span
                      className={`h-5 w-5 rounded-full bg-background shadow-sm transition-transform ${draft.enabled ? 'translate-x-5' : ''}`}
                    />
                  </button>
                </div>
                <label htmlFor={`${promptId}-agent`} className="mb-2 block text-text-secondary">
                  {t('standIn.agent')}
                </label>
                <select
                  id={`${promptId}-agent`}
                  data-testid="stand-in-agent"
                  value={draft.agentId ?? ''}
                  disabled={saving || !canConfigure || !loaded}
                  onChange={event =>
                    setDraft(current => ({ ...current, agentId: event.target.value || null }))
                  }
                  className="mb-4 w-full rounded-lg border border-border bg-background p-2 outline-none focus:border-focus"
                >
                  <option value="">{t('standIn.default_agent')}</option>
                  {draft.agentId && !agents.some(agent => agent.id === draft.agentId) && (
                    <option value={draft.agentId}>{t('standIn.agent_unavailable')}</option>
                  )}
                  {agents.map(agent => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))}
                </select>
                {agentError && (
                  <p role="alert" className="mb-3 text-xs text-error">
                    {t('standIn.agent_load_failed')} {agentError}
                  </p>
                )}
                <label htmlFor={promptId} className="mb-2 block text-text-secondary">
                  {t('standIn.prompt')}
                </label>
                <textarea
                  id={promptId}
                  data-testid="stand-in-prompt"
                  maxLength={8000}
                  disabled={saving || !canConfigure || !loaded}
                  value={draft.prompt}
                  onChange={event =>
                    setDraft(current => ({ ...current, prompt: event.target.value }))
                  }
                  placeholder={t('standIn.prompt_placeholder')}
                  className="h-24 w-full resize-y rounded-lg border border-border bg-background p-3 outline-none focus:border-focus"
                />
                <div className="mt-3 flex items-center gap-2">
                  <Monitor className="h-4 w-4" />
                  <label htmlFor={`${promptId}-device`}>{t('standIn.device')}</label>
                  <select
                    id={`${promptId}-device`}
                    data-testid="stand-in-device"
                    disabled={saving || !canConfigure}
                    value={draft.executionDeviceId}
                    onChange={event => void selectDevice(event.target.value)}
                    className="min-w-0 flex-1 rounded bg-background p-1 outline-none"
                  >
                    <option value="">{t('standIn.select_device')}</option>
                    {selectionMissing && (
                      <option value={draft.executionDeviceId}>
                        {t('standIn.device_unavailable')}
                      </option>
                    )}
                    {availableDevices.map(device => (
                      <option
                        key={device.device_id}
                        value={
                          [device.device_id, device.app_device_id].includes(draft.executionDeviceId)
                            ? draft.executionDeviceId
                            : device.device_id
                        }
                      >
                        {device.name}
                        {currentDeviceId &&
                        [device.device_id, device.app_device_id].includes(currentDeviceId) &&
                        device.name !== t('standIn.current_device')
                          ? ` · ${t('standIn.current_device')}`
                          : ''}
                        {device.status === 'offline' ? ` · ${t('standIn.offline')}` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            )}
            {!canConfigure && (
              <p className="mt-3 text-xs text-text-muted">{t('standIn.no_permission')}</p>
            )}
            {error && (
              <div role="alert" className="mt-3 text-xs text-error">
                <p>{error}</p>
                <button
                  type="button"
                  data-testid="stand-in-reload"
                  onClick={() => {
                    if (draft.executionDeviceId) void selectDevice(draft.executionDeviceId)
                    else {
                      setLoading(true)
                      setLoaded(false)
                      setError(null)
                      void load({ cancelled: false })
                    }
                  }}
                  className="mt-1 underline"
                >
                  {t('standIn.reload')}
                </button>
              </div>
            )}
            <div className="mt-6 flex items-center gap-2">
              <p className="mr-auto text-xs text-text-muted">{t('standIn.future_only')}</p>
              <Popover.Close asChild>
                <button
                  type="button"
                  disabled={saving}
                  data-testid="stand-in-cancel"
                  className="rounded-lg border border-border px-4 py-2"
                >
                  {t('standIn.cancel')}
                </button>
              </Popover.Close>
              <button
                type="button"
                disabled={
                  !loaded ||
                  loading ||
                  saving ||
                  !canConfigure ||
                  (draft.enabled && (!draft.executionDeviceId || selectionMissing))
                }
                data-testid="stand-in-save"
                onClick={() => void save()}
                className="rounded-lg bg-text-primary px-4 py-2 text-background disabled:opacity-40"
              >
                {t(saving ? 'standIn.saving' : 'standIn.save')}
              </button>
            </div>
          </div>
          <Popover.Arrow className="fill-background" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
