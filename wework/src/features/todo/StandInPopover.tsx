import type { StandInProjectSettings } from '@/api/standIn'
import { StandInComposer } from './StandInComposer'
import { StandInIcon } from './StandInIcon'
import * as Popover from '@radix-ui/react-popover'
import { Bot, ChevronDown, Monitor } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { dequal } from 'dequal'
import type {
  CollaborationProject,
  SharedWorkspaceApi,
  WorkspaceStandInSettings,
  WorkspaceProjectAgent,
} from '@wegent/collaboration'
import { useTranslation } from '@/hooks/useTranslation'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { DeviceInfo, RuntimeWorkListResponse } from '@/types/api'

const emptySettings: WorkspaceStandInSettings = {
  enabled: false,
  prompt: '',
  executionDeviceId: '',
  version: 0,
}

const configurationKeys = [
  'prompt',
  'executionDeviceId',
  'agentId',
  'model',
  'modelOptions',
  'workspace',
  'goalMode',
  'name',
  'tags',
] as const

export function StandInPopover({
  api,
  project,
  devices = [],
  readLocalIdentity,
  services,
  initialDeviceId,
  initialProfileId = 'default',
  onSaved,
  onSavingChange,
  onCancel,
  embedded = false,
  userId,
  projects = [],
}: {
  userId?: number
  projects?: CollaborationProject[]
  embedded?: boolean
  services?: WorkbenchServices
  initialProfileId?: string
  initialDeviceId?: string
  onSaved?(settings: WorkspaceStandInSettings, action?: 'settings' | 'automatic'): void
  onSavingChange?(saving: boolean): void
  onCancel?(): void
  api: SharedWorkspaceApi
  project: CollaborationProject
  devices?: DeviceInfo[]
  readLocalIdentity?: WorkbenchServices['getLocalRuntimeSidebarIdentity']
}) {
  const { t } = useTranslation('common')
  const promptId = useId()
  const [open, setOpen] = useState(embedded)
  const [profileId, setProfileId] = useState(initialProfileId)
  const [profiles, setProfiles] = useState<StandInProjectSettings[]>([])
  const [reuseNotice, setReuseNotice] = useState(false)
  const [saved, setSaved] = useState(emptySettings)
  const [draft, setDraft] = useState(emptySettings)
  const [pendingEnable, setPendingEnable] = useState(false)
  const deviceLoad = useRef(0)
  const selectedDevice = useRef(initialDeviceId ?? '')
  const [currentDeviceId, setCurrentDeviceId] = useState('')
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [composerValid, setComposerValid] = useState(false)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    onSavingChange?.(saving)
  }, [saving, onSavingChange])
  const [error, setError] = useState<string | null>(null)
  const [agents, setAgents] = useState<WorkspaceProjectAgent[]>([])
  const [agentError, setAgentError] = useState<string | null>(null)
  const [workspaceResult, setWorkspaceResult] = useState<{
    deviceId: string
    work: RuntimeWorkListResponse | null
    error: string | null
  } | null>(null)
  const currentWorkspace =
    workspaceResult?.deviceId === draft.executionDeviceId ? workspaceResult : null
  const runtimeWork = currentWorkspace?.work ?? null
  const workspaceError = currentWorkspace?.error ?? null
  const [notice, setNotice] = useState<string | null>(null)
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
          return api.standIn!.get(
            project.id,
            selectedDevice.current || undefined,
            ...(profileId === 'default' ? [] : [profileId])
          )
        })
        .then(settings => {
          if (signal.cancelled || !settings) return
          setError(null)
          setSaved(settings)
          setPendingEnable(false)
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
    [api, project.id, readLocalIdentity, profileId]
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
      .list(project.id, { forceRefresh: true })
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
    setLoading(true)
    setPendingEnable(false)
    setError(null)
    try {
      const settings = await api.standIn!.get(
        project.id,
        deviceId,
        ...(profileId === 'default' ? [] : [profileId])
      )
      if (revision !== deviceLoad.current) return
      setSaved(settings)
      setDraft({ ...settings, executionDeviceId: deviceId })
      setLoaded(true)
    } catch (cause) {
      if (revision === deviceLoad.current)
        setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (revision === deviceLoad.current) setLoading(false)
    }
  }

  useEffect(() => {
    if (!open || !services?.runtimeWorkApi || !draft.executionDeviceId) return
    let active = true
    const deviceId = draft.executionDeviceId
    void services.runtimeWorkApi
      .listRuntimeWork({ deviceId: draft.executionDeviceId })
      .then(work => {
        if (active) setWorkspaceResult({ deviceId, work, error: null })
      })
      .catch(cause => {
        if (active)
          setWorkspaceResult({
            deviceId,
            work: null,
            error: cause instanceof Error ? cause.message : String(cause),
          })
      })
    return () => {
      active = false
    }
  }, [open, services, draft.executionDeviceId])

  useEffect(() => {
    if (!open || !services?.standInApi || userId == null || !draft.executionDeviceId) return
    let active = true
    void services.standInApi
      .list(userId, draft.executionDeviceId, true)
      .then(rows => {
        if (active) setProfiles(rows)
      })
      .catch(cause => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      active = false
    }
  }, [open, services, userId, draft.executionDeviceId, saved.version])

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
  const persist = async (settings: WorkspaceStandInSettings, action: 'settings' | 'automatic') => {
    if (!api.standIn || !loaded || loading || saving) return
    setSaving(true)
    setError(null)
    try {
      const result = await api.standIn.save(project.id, settings)
      setSaved(result)
      setPendingEnable(false)
      // Accept server metadata while retaining only unsaved configuration edits.
      setDraft(current =>
        action === 'automatic'
          ? {
              ...result,
              ...Object.fromEntries(
                configurationKeys
                  .filter(key => !dequal(current[key], settings[key]))
                  .map(key => [key, current[key]])
              ),
            }
          : result
      )
      onSaved?.(result, action)
      if (action === 'settings' && !embedded) setOpen(false)
      setNotice(
        t(
          action === 'settings'
            ? 'standIn.saved'
            : result.enabled
              ? 'standIn.automatic_enabled'
              : 'standIn.automatic_disabled'
        )
      )
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      setSaving(false)
    }
  }

  const projectStore = project.project_store === 'local' ? 'local' : 'cloud'
  const sameProjectProfiles = profiles.filter(
    row => row.projectId === project.id && row.projectStore === projectStore
  )
  const reuseProfiles = profiles.filter(
    row => row.projectId !== project.id || row.projectStore !== projectStore
  )
  const savedConfiguration = {
    ...saved,
    executionDeviceId: saved.executionDeviceId || currentDeviceId,
  }
  const hasChanges = configurationKeys.some(key => !dequal(draft[key], savedConfiguration[key]))
  const save = (prompt: string) =>
    persist({ ...draft, prompt, enabled: saved.enabled || pendingEnable }, 'settings')
  const toggleAutomatic = () => {
    setNotice(null)
    if (pendingEnable) {
      setPendingEnable(false)
    } else if (!saved.enabled && (saved.version === 0 || hasChanges || !composerValid)) {
      setPendingEnable(true)
    } else {
      void persist(
        { ...saved, executionDeviceId: draft.executionDeviceId, enabled: !saved.enabled },
        'automatic'
      )
    }
  }
  const editor = (
    <>
      <div className="p-4">
        <button
          type="button"
          role="switch"
          aria-checked={saved.enabled}
          aria-busy={saving}
          aria-label={t('standIn.auto_label')}
          data-testid="stand-in-auto"
          disabled={saving || !loaded || (!saved.enabled && saved.version > 0 && !composerValid)}
          onClick={toggleAutomatic}
          className="flex w-full items-center justify-between gap-4 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-40"
        >
          <span className="min-w-0">
            <span className="text-sm font-medium text-text-primary">{t('standIn.auto_label')}</span>
            <span className="mt-1 block text-xs text-text-muted">
              {t('standIn.auto_description')}
            </span>
          </span>
          <span
            aria-hidden="true"
            className={`inline-flex h-6 w-10 shrink-0 items-center rounded-full p-0.5 transition-colors ${saved.enabled ? 'bg-text-primary' : 'bg-border'}`}
          >
            <span
              className={`h-5 w-5 rounded-full bg-background shadow-sm transition-transform ${saved.enabled ? 'translate-x-4' : ''}`}
            />
          </span>
        </button>
        {pendingEnable && (
          <p
            role="status"
            data-testid="stand-in-enable-notice"
            className="mt-2 text-xs text-text-muted"
          >
            {t(
              saved.version === 0 ? 'standIn.configure_before_enable' : 'standIn.save_before_enable'
            )}
          </p>
        )}
        <h3 className="mb-3 mt-4 border-t border-border pt-4 text-sm font-medium">
          {t('standIn.settings')}
        </h3>
        {sameProjectProfiles.some(row => row.id && row.id !== 'default') && (
          <label className="mb-3 flex items-center gap-2 text-sm text-text-secondary">
            {t('standIn.existing_profile')}
            <select
              data-testid="stand-in-profile-select"
              value={profileId}
              disabled={saving}
              onChange={event => {
                setLoading(true)
                setLoaded(false)
                setProfileId(event.target.value)
              }}
              className="min-h-11 min-w-0 flex-1 rounded-md border border-border bg-background px-2 md:min-h-8"
            >
              <option value="default">{t('standIn.default_profile')}</option>
              {sameProjectProfiles
                .filter(row => row.id !== 'default')
                .map(row => (
                  <option key={row.id} value={row.id}>
                    {row.name || row.id}
                  </option>
                ))}
            </select>
          </label>
        )}
        {reuseProfiles.length > 0 && (
          <label className="mb-3 flex items-center gap-2 text-sm text-text-secondary">
            {t('standIn.copy_from')}
            <select
              data-testid="stand-in-reuse-select"
              value=""
              disabled={saving || !loaded}
              onChange={event => {
                const source = reuseProfiles[Number(event.target.value)]
                if (!source) return
                setDraft(current => ({
                  ...current,
                  prompt: source.prompt,
                  model: source.model,
                  modelOptions: source.modelOptions,
                  workspace: source.workspace,
                  goalMode: source.goalMode,
                  agentId: source.agentId,
                  name: source.name,
                }))
                setReuseNotice(true)
              }}
              className="min-h-11 min-w-0 flex-1 rounded-md border border-border bg-background px-2 md:min-h-8"
            >
              <option value="">{t('standIn.choose_existing')}</option>
              {reuseProfiles.map((row, index) => (
                <option key={`${row.projectStore}:${row.projectId}:${row.id}`} value={index}>
                  {projects.find(
                    project =>
                      project.id === row.projectId &&
                      (project.project_store === 'local' ? 'local' : 'cloud') === row.projectStore
                  )?.name ?? row.projectId}{' '}
                  · {row.name || t('standIn.default_profile')}
                </option>
              ))}
            </select>
          </label>
        )}
        {reuseNotice && (
          <p role="status" className="mb-3 text-xs text-text-muted">
            {t('standIn.copied')}
          </p>
        )}

        {loading ? (
          <p role="status" className="text-text-muted">
            {t('standIn.loading')}
          </p>
        ) : loaded ? (
          <>
            <StandInComposer
              draft={draft}
              onChange={setDraft}
              onSave={save}
              onValidityChange={setComposerValid}
              disabled={saving || !loaded}
              submitDisabled={!draft.executionDeviceId || selectionMissing}
              runtimeWork={runtimeWork}
              devices={devices}
              services={services}
              deviceControl={
                <div className="inline-flex h-8 min-w-0 shrink-0 items-center gap-1.5 rounded-lg px-1.5 text-sm text-text-secondary hover:bg-muted">
                  <Monitor className="h-4 w-4" />
                  <label className="sr-only" htmlFor={`${promptId}-device`}>
                    {t('standIn.device')}
                  </label>
                  <select
                    id={`${promptId}-device`}
                    data-testid="stand-in-device"
                    disabled={saving}
                    value={draft.executionDeviceId}
                    onChange={event => void selectDevice(event.target.value)}
                    className="h-8 min-w-0 max-w-44 cursor-pointer appearance-none bg-transparent text-sm outline-none"
                  >
                    {!currentDeviceId && <option value="">{t('standIn.select_device')}</option>}
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
                  <ChevronDown className="h-4 w-4 shrink-0" />
                </div>
              }
              selectedAgent={agents.find(agent => agent.id === draft.agentId)}
              controls={
                <div className="inline-flex h-8 min-w-0 shrink-0 items-center gap-1.5 rounded-lg px-1.5 text-sm text-text-secondary hover:bg-muted">
                  <Bot className="h-4 w-4 shrink-0" />
                  <select
                    aria-label={t('standIn.agent')}
                    data-testid="stand-in-agent"
                    value={draft.agentId ?? ''}
                    disabled={saving || !loaded}
                    onChange={event =>
                      setDraft(current => ({
                        ...current,
                        agentId: event.target.value || null,
                        model: null,
                      }))
                    }
                    className="h-8 min-w-0 max-w-40 cursor-pointer appearance-none bg-transparent text-sm outline-none"
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
                  <ChevronDown className="h-4 w-4 shrink-0" />
                </div>
              }
            />
            {(agentError || workspaceError) && (
              <p role="alert" className="mt-2 text-xs text-error">
                {agentError || workspaceError}
              </p>
            )}
          </>
        ) : null}
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
        {loaded && (
          <div className="mt-4 flex items-center justify-end gap-2">
            <button
              type="button"
              disabled={saving}
              data-testid="stand-in-cancel"
              onClick={() => {
                setDraft(saved)
                setPendingEnable(false)
                if (embedded) onCancel?.()
                else setOpen(false)
              }}
              className="min-h-8 rounded-md px-3 text-sm text-text-secondary hover:bg-muted"
            >
              {t('standIn.cancel')}
            </button>
            <button
              type="button"
              data-testid="stand-in-save"
              disabled={
                !loaded ||
                loading ||
                saving ||
                !composerValid ||
                !draft.executionDeviceId ||
                selectionMissing
              }
              onClick={() => void save(draft.prompt)}
              className="min-h-8 rounded-md bg-text-primary px-3 text-sm font-medium text-background disabled:opacity-40"
            >
              {t(
                saving
                  ? 'standIn.saving'
                  : pendingEnable
                    ? 'standIn.save_and_enable'
                    : 'standIn.save'
              )}
            </button>
          </div>
        )}
      </div>
    </>
  )
  if (embedded)
    return (
      <section data-testid="stand-in-settings" className="w-full text-sm text-text-primary">
        {editor}
        {notice && (
          <p role="status" className="px-4 text-xs text-text-muted">
            {notice}
          </p>
        )}
      </section>
    )

  return (
    <Popover.Root
      open={open}
      onOpenChange={next => {
        if (!saving) {
          deviceLoad.current += 1
          setOpen(next)
          setNotice(null)
          setPendingEnable(false)
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
          aria-label={t('standIn.action_label')}
          title={t(saved.enabled ? 'standIn.enabled' : 'standIn.action_label')}
          className="relative z-10 inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-text-secondary hover:bg-muted"
        >
          <StandInIcon enabled={saved.enabled} />
          <span>{t('standIn.action_label')}</span>
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
          aria-label={t('standIn.action_label')}
          align="end"
          sideOffset={8}
          collisionPadding={12}
          className="z-popover max-h-[var(--radix-popover-content-available-height)] w-[560px] max-w-[calc(100vw-24px)] overflow-y-auto rounded-xl border border-border bg-background text-sm text-text-primary shadow-lg"
          data-testid="stand-in-settings"
          onEscapeKeyDown={event => {
            if (saving) event.preventDefault()
          }}
          onInteractOutside={event => {
            if (saving) event.preventDefault()
          }}
        >
          {editor}
          <Popover.Arrow className="fill-background" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
