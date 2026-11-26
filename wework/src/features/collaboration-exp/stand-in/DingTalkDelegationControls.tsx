import {
  newStandInPrimaryRole,
  STAND_IN_DINGTALK_PROVIDER,
  type StandInDingTalkDelegation,
  type StandInIdentity,
} from '@/api/personalStandIn'
import type {
  ConnectionProviderDescriptor,
  ConnectionReadinessSource,
  StandInExecutorApi,
} from '@/api/standIn'
import { ModelSelector } from '@/components/chat/composer/ModelSelector'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { LocalConnectorAuthDialog } from '@/components/plugins/LocalConnectorAuthDialog'
import { Button } from '@/components/ui/button'
import { useOptionalAppUpdate } from '@/features/app-update/app-update-context'
import { formatAppUpdateProgress } from '@/features/app-update/app-update-progress-copy'
import { StandInSourceConnections } from '@/features/todo/StandInSourceConnections'
import { useStandInModels } from '@/features/todo/useStandInModels'
import { useStandInPanelNavigation } from '@/features/todo/useStandInPanelNavigation'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import type { DeviceInfo } from '@/types/api'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import type { RunnerModelIdentity, WorkspaceStandInSettings } from '@wegent/collaboration'
import { Checkbox } from '@wegent/collaboration/controls/Checkbox'
import { dequal } from 'dequal'
import { useImperativeHandle, useMemo, useState, useSyncExternalStore, type Ref } from 'react'
import {
  defaultDingTalkDelegation,
  delegationTemplates,
  dingTalkDelegationModel,
  isDingTalkSource,
  matchesDingTalkAccount,
} from './dingtalkDelegation'

export interface DingTalkDelegationSettings {
  saved: StandInIdentity
  services?: WorkbenchServices
  devices?: DeviceInfo[]
  sourceProblem?: string
  primaryStopped: boolean
  modelSelection?: {
    identity: RunnerModelIdentity | null
    label?: string | null
    options?: WorkspaceStandInSettings['modelOptions']
  }
  onSave(value: StandInIdentity): Promise<boolean>
  onBusyChange?(busy: boolean): void
}

export interface DingTalkDelegationNavigation {
  requestLeave(action: () => void): void
}

type DelegationAction = StandInDingTalkDelegation['action']

function readSelection(rows: StandInIdentity['connections']): ConnectionReadinessSource[] {
  return (rows ?? []).flatMap(({ id, kind, paused }) =>
    !paused && (kind === 'direct' || kind === 'group') ? [{ id, kind }] : []
  )
}

// The same account and scope editor serves first-time setup and settings.
export function DingTalkDelegationControls({
  settings,
  api,
  provider,
  deviceId,
  localDeviceId,
  disabled,
  ref,
}: {
  settings: DingTalkDelegationSettings
  api: StandInExecutorApi
  provider: ConnectionProviderDescriptor
  deviceId: string
  localDeviceId: string
  disabled: boolean
  ref?: Ref<DingTalkDelegationNavigation>
}) {
  const { t } = useTranslation('common')
  const { saved } = settings
  const savedDelegation = saved.delegation
  const device = settings.devices?.find(candidate => candidate.device_id === deviceId)
  const local = deviceId === localDeviceId && device?.status !== 'offline'
  const update = useOptionalAppUpdate()
  const updatePending =
    update?.status === 'installing' || update?.downloadProgress?.phase === 'ready'
  const updateFailed = update?.downloadProgress?.phase === 'failed'
  const updating = update?.status === 'downloading' && !updatePending && !updateFailed
  const [profile, setProfile] = useState<string>()
  const [switching, setSwitching] = useState(false)
  const [authOpen, setAuthOpen] = useState(false)
  const [draft, setDraft] = useState<StandInIdentity>()
  const [selectedModel, setSelectedModel] = useState<RunnerModelIdentity | null>()
  const [modelOptions, setModelOptions] = useState<WorkspaceStandInSettings['modelOptions']>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [readVerified, setReadVerified] = useState(false)
  const [readDenied, setReadDenied] = useState(false)
  const [discard, setDiscard] = useState(false)
  const requestedProfile = switching ? undefined : (profile ?? savedDelegation?.profile)
  const resource = useMemo(
    () =>
      createAsyncResource(JSON.stringify([deviceId, requestedProfile]), () =>
        api.connectionReadiness(deviceId, STAND_IN_DINGTALK_PROVIDER, requestedProfile)
      ),
    [api, deviceId, requestedProfile]
  )
  const shouldCheck =
    local && ['ready', 'auth_required', 'error'].includes(provider.availability.status)
  const result = useSyncExternalStore(
    shouldCheck ? resource.subscribe : subscribeIdleResource,
    resource.getSnapshot,
    getIdleResourceSnapshot
  )
  const readiness = result.status === 'ready' ? result.data : undefined
  const identity = readiness?.identity
  const connected = readiness?.status === 'ready' && !!identity && !switching
  const accountChanged = Boolean(
    savedDelegation?.accountId && identity && !matchesDingTalkAccount(identity, savedDelegation)
  )
  const currentAccount = identity ?? savedDelegation
  const scopedAvailability = { status: connected ? 'ready' : 'unavailable', ...identity }
  const withoutDingTalk = (saved.connections ?? []).filter(row => !isDingTalkSource(row))
  const savedSelection = {
    ...saved,
    delegation: savedDelegation ?? defaultDingTalkDelegation,
    connections: (saved.connections ?? []).filter(
      row => !isDingTalkSource(row) || matchesDingTalkAccount(identity, row)
    ),
  }
  const selection = draft ?? savedSelection
  const delegation = dingTalkDelegationModel(saved, selection, scopedAvailability)
  const active =
    saved.enabled &&
    delegation.authorized &&
    !savedDelegation?.paused &&
    !settings.primaryStopped &&
    !accountChanged
  const granted = Boolean(savedDelegation?.authorized && !savedDelegation.paused)
  const sourceAuthProblem = granted && settings.sourceProblem === 'connector_auth_required'
  const permissionDenied =
    readDenied || (granted && settings.sourceProblem === 'dingtalk_permissions_required')
  let status = 'checking'
  if (!local) status = 'offline'
  else if (switching || readiness?.status === 'identity_required') status = 'choose_account'
  else if (sourceAuthProblem || readiness?.status === 'auth_required')
    status = savedDelegation?.profile ? 'expired' : 'disconnected'
  else if (connected) status = 'connected'
  else if (!shouldCheck || result.status === 'error' || readiness) status = 'connection_failed'

  const baseRole = newStandInPrimaryRole(deviceId)
  const models = useStandInModels(
    settings.services,
    { ...baseRole, model: selectedModel ?? saved.model },
    'codex',
    local && !settings.modelSelection
  )
  const selected = settings.modelSelection
    ? settings.modelSelection.identity
    : models.resolve(models.selectedModel)
  const model =
    selected?.runtime === 'codex' &&
    !models.errors[selected.source === 'cloud' ? 'cloud' : 'native']
      ? selected
      : null
  const modelLabel = settings.modelSelection?.label ?? models.selectedModel?.displayName
  const options = settings.modelSelection?.options ?? modelOptions ?? saved.modelOptions
  const dirty = Boolean(
    (draft && !dequal(draft, savedSelection)) || selectedModel !== undefined || modelOptions
  )
  const navigation = useStandInPanelNavigation(dirty, busy || authOpen, () => setDiscard(true))
  useImperativeHandle(ref, () => ({ requestLeave: navigation.requestLeave }))
  const authTarget = readiness?.authTarget ?? provider.authTarget
  const blocked = disabled || busy || !local
  const canStart =
    !blocked && connected && !sourceAuthProblem && !updatePending && !updateFailed && !!model
  const canEdit = !blocked && connected && !accountChanged
  const repair = (path: string) => navigation.requestLeave(() => navigateTo(path))
  const scopes = readSelection(delegation.selected)
  const canEnable = canStart && delegation.canEnable && !settings.primaryStopped
  const saveAvailable =
    canEdit &&
    dirty &&
    (delegation.authorized
      ? !active || !delegation.widens || canStart
      : !!model && scopes.length > 0)

  const resetDraft = () => {
    setDraft(undefined)
    setSelectedModel(undefined)
    setModelOptions(undefined)
  }
  const updateDraft = (next: StandInIdentity) => {
    setDraft(next)
    setReadVerified(false)
    setReadDenied(false)
  }
  const persist = async (action?: DelegationAction) => {
    if (blocked || (action !== 'pause' && !identity)) return false
    const enable = action === 'enable'
    const changingAccount = action === 'prepare' && accountChanged
    const verifyRead =
      enable || action === 'resume' || (!action && active && delegation.widens && scopes.length > 0)

    setBusy(true)
    settings.onBusyChange?.(true)
    setError(undefined)
    setReadDenied(false)
    try {
      if (verifyRead && identity) {
        const access = await api.connectionReadiness(
          deviceId,
          STAND_IN_DINGTALK_PROVIDER,
          identity.profile,
          scopes
        )
        if (
          access.status !== 'ready' ||
          access.permissions?.read !== 'verified' ||
          !matchesDingTalkAccount(access.identity, identity)
        ) {
          setReadDenied(access.status === 'permissions_required')
          setError(
            t(
              access.status === 'permissions_required'
                ? 'standIn.dingtalk_delegation.permissions_required'
                : 'standIn.dingtalk_delegation.connection_failed'
            )
          )
          return false
        }
      }
      const next =
        action === 'pause'
          ? saved
          : action === 'prepare'
            ? {
                ...selection,
                connections: changingAccount
                  ? withoutDingTalk
                  : [...withoutDingTalk, ...delegation.selected],
                delegation: changingAccount ? defaultDingTalkDelegation : delegation.delegation,
              }
            : delegation.submission(enable)
      const savedNext = await settings.onSave({
        ...next,
        ...(action !== 'pause' && model ? { model, modelOptions: options } : {}),
        delegation: {
          ...(next.delegation ?? defaultDingTalkDelegation),
          ...(action === 'pause' ? {} : identity),
          action,
        },
      })
      if (!savedNext) {
        setError(t('standIn.dingtalk_delegation.save_failed'))
        return false
      }
      if (action !== 'pause') resetDraft()
      setReadVerified(verifyRead)
      return true
    } catch (cause) {
      setError(getStandInErrorMessage(cause))
      return false
    } finally {
      setBusy(false)
      settings.onBusyChange?.(false)
    }
  }
  const switchAccount = async () => {
    if (granted && !(await persist('pause'))) return
    resetDraft()
    setReadVerified(false)
    setReadDenied(false)
    setError(undefined)
    setProfile(undefined)
    setSwitching(true)
  }
  return (
    <section className="space-y-4" data-testid="stand-in-delegation">
      <div className="space-y-1">
        <h3 className="font-medium">
          {delegation.authorized
            ? t('standIn.dingtalk_delegation.version', { version: savedDelegation?.version })
            : t('standIn.dingtalk_delegation.title')}
        </h3>
        <p className="text-sm text-text-secondary">{t('standIn.dingtalk_delegation.scope_help')}</p>
        {!savedDelegation?.profile && saved.connections?.some(isDingTalkSource) && (
          <p className="text-sm text-text-secondary">
            {t('standIn.dingtalk_delegation.replaces_legacy')}
          </p>
        )}
      </div>
      <dl className="grid gap-2 text-sm sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-x-4">
        <dt className="text-text-secondary">{t('standIn.device')}</dt>
        <dd>
          {device?.name ?? t(local ? 'standIn.current_device' : 'standIn.device_unavailable')}
        </dd>
        <dt className="text-text-secondary">{t('standIn.dingtalk_delegation.account_identity')}</dt>
        <dd data-testid="stand-in-dingtalk-account">
          {currentAccount?.profile && !switching
            ? [
                currentAccount.accountName ?? currentAccount.profile,
                currentAccount.organizationName,
              ]
                .filter(Boolean)
                .join(' · ')
            : t('standIn.dingtalk_delegation.no_account')}
        </dd>
        <dt className="text-text-secondary">{t('standIn.dingtalk_delegation.connection')}</dt>
        <dd role="status">{t('standIn.dingtalk_delegation.' + status)}</dd>
        <dt className="text-text-secondary">{t('standIn.dingtalk_delegation.read_access')}</dt>
        <dd>
          {t(
            permissionDenied
              ? 'standIn.dingtalk_delegation.permissions_required'
              : readVerified || (active && connected && !!savedDelegation?.organizationId)
                ? 'standIn.dingtalk_delegation.read_verified'
                : 'standIn.dingtalk_delegation.read_pending'
          )}
        </dd>
        <dt className="text-text-secondary">{t('standIn.dingtalk_delegation.title')}</dt>
        <dd>
          {t(
            active && connected && !sourceAuthProblem && !permissionDenied
              ? 'standIn.dingtalk_delegation.enabled'
              : 'standIn.dingtalk_delegation.paused'
          )}
        </dd>
        {readiness?.component && (
          <>
            <dt className="text-text-secondary">{t('standIn.dingtalk_delegation.component')}</dt>
            <dd>
              {t('standIn.dingtalk_delegation.' + readiness.component.source)} ·{' '}
              {readiness.component.version}
            </dd>
          </>
        )}
      </dl>
      {local && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            className="min-h-11 md:min-h-9"
            data-testid="stand-in-dingtalk-recheck"
            disabled={blocked || !shouldCheck || result.status === 'loading'}
            onClick={() => {
              setReadVerified(false)
              setReadDenied(false)
              setError(undefined)
              void resource.reload()
            }}
          >
            {t('standIn.reload')}
          </Button>
          {(connected || !!savedDelegation?.profile) && !switching && (
            <Button
              variant="outline"
              className="min-h-11 md:min-h-9"
              data-testid="stand-in-dingtalk-switch-account"
              disabled={blocked}
              onClick={() => navigation.requestLeave(() => void switchAccount())}
            >
              {t('standIn.dingtalk_delegation.switch_account')}
            </Button>
          )}
          {authTarget && (switching || status === 'expired' || status === 'disconnected') && (
            <Button
              variant="outline"
              className="min-h-11 md:min-h-9"
              data-testid="stand-in-dingtalk-authorize"
              disabled={blocked}
              onClick={() => setAuthOpen(true)}
            >
              {t('standIn.dingtalk_delegation.authorize')}
            </Button>
          )}
        </div>
      )}
      {(updating || updatePending || updateFailed || status === 'connection_failed') && (
        <div className="space-y-1 text-sm text-text-secondary">
          {updating && <p role="status">{formatAppUpdateProgress(update.downloadProgress, t)}</p>}
          {(updatePending || updateFailed) && (
            <p role="status">
              {t(
                updatePending
                  ? 'standIn.dingtalk_delegation.update_restart'
                  : 'standIn.dingtalk_delegation.update_failed'
              )}
            </p>
          )}
          <Button
            variant="ghost"
            className="min-h-11 md:min-h-9"
            data-testid="stand-in-dingtalk-open-updates"
            disabled={busy}
            onClick={() => repair('/settings/about')}
          >
            {t('standIn.dingtalk_delegation.open_updates')}
          </Button>
        </div>
      )}
      {local &&
        (switching ||
          status === 'choose_account' ||
          status === 'expired' ||
          status === 'disconnected') && (
          <div className="flex flex-wrap gap-2">
            {readiness?.candidates?.map(candidate => (
              <Button
                key={candidate.profile}
                variant="outline"
                className="min-h-11 md:min-h-9"
                data-testid={'stand-in-dingtalk-select-account-' + candidate.profile}
                disabled={blocked}
                onClick={() => {
                  setProfile(candidate.profile)
                  setSwitching(false)
                }}
              >
                {candidate.accountName} · {candidate.organizationName}
              </Button>
            ))}
          </div>
        )}
      {connected && accountChanged && (
        <div className="space-y-2 text-sm">
          <p>{t('standIn.dingtalk_delegation.account_changed')}</p>
          <Button
            className="min-h-11 md:min-h-9"
            data-testid="stand-in-dingtalk-confirm-account"
            disabled={blocked}
            onClick={() => void persist('prepare')}
          >
            {t('standIn.dingtalk_delegation.confirm_account')}
          </Button>
        </div>
      )}
      {connected && !accountChanged && (
        <>
          <div className="space-y-2 text-sm">
            <h4 className="font-medium">{t('standIn.model_label')}</h4>
            {settings.modelSelection ? (
              <p>{modelLabel ?? t('standIn.errors.model_unavailable')}</p>
            ) : (
              <ModelSelector
                models={models.models}
                getModelOptionId={models.getModelOptionId}
                selectedModel={models.selectedModel}
                selectedModelOptions={options ?? {}}
                disabled={blocked || models.loading}
                buttonClassName="min-h-11 rounded-md border border-border md:min-h-8"
                menuPlacement="below"
                menuAlign="start"
                menuClassName="z-critical"
                onSelectModel={entry => {
                  setSelectedModel(models.resolve(entry))
                  setModelOptions({})
                }}
                onSelectModelAndOptions={(entry, nextOptions) => {
                  setSelectedModel(models.resolve(entry))
                  setModelOptions(nextOptions)
                }}
                onSelectModelOption={(key, value) =>
                  setModelOptions(previous => ({
                    ...saved.modelOptions,
                    ...previous,
                    [key]: value,
                  }))
                }
                onOpenChange={open => {
                  if (open) models.refresh()
                }}
              />
            )}
            {model ? (
              <p className="text-xs text-text-secondary">
                {t(
                  model.source === 'cloud'
                    ? 'standIn.dingtalk_delegation.cloud_inference'
                    : 'standIn.dingtalk_delegation.native_inference'
                )}
              </p>
            ) : (
              <>
                {!models.loading && (
                  <p className="text-text-secondary">
                    {models.error ?? t('standIn.errors.model_unavailable')}
                  </p>
                )}
                <Button
                  variant="ghost"
                  className="min-h-11 md:min-h-9"
                  data-testid="stand-in-dingtalk-open-models"
                  disabled={busy}
                  onClick={() => repair('/settings/personal/models')}
                >
                  {t('standIn.dingtalk_delegation.open_models')}
                </Button>
              </>
            )}
          </div>
          <StandInSourceConnections
            provider={{ ...provider, availability: scopedAvailability, authTarget }}
            role={{ ...baseRole, connections: selection.connections }}
            api={api}
            deviceId={deviceId}
            localDeviceId={localDeviceId}
            delegatedDingTalk
            disabled={blocked}
            onChange={role => updateDraft({ ...selection, connections: role.connections })}
            onReady={() => void resource.reload()}
          />
          <fieldset className="space-y-2" disabled={blocked}>
            <legend className="mb-2 text-sm font-medium">
              {t('standIn.dingtalk_delegation.templates')}
            </legend>
            {delegationTemplates.map(template => (
              <label
                key={template}
                className="flex min-h-11 items-center justify-between gap-3 py-1 text-sm md:min-h-9"
              >
                <span className="min-w-0">
                  <span className="block font-medium">
                    {t('standIn.dingtalk_delegation.' + template)}
                  </span>
                  <span className="block text-xs text-text-secondary">
                    {t('standIn.dingtalk_delegation.' + template + '_description')}
                  </span>
                </span>
                <Checkbox
                  data-testid={'stand-in-delegation-template-' + template}
                  checked={delegation.delegation.templates[template]}
                  disabled={blocked}
                  onCheckedChange={checked =>
                    updateDraft({
                      ...selection,
                      delegation: {
                        ...delegation.delegation,
                        templates: {
                          ...delegation.delegation.templates,
                          [template]: checked === true,
                        },
                      },
                    })
                  }
                />
              </label>
            ))}
          </fieldset>
          {!scopes.length && (
            <p className="text-sm text-text-secondary" data-testid="stand-in-delegation-no-sources">
              {t(
                delegation.authorized
                  ? 'standIn.dingtalk_delegation.remove_all'
                  : 'standIn.dingtalk_delegation.choose_sources'
              )}
            </p>
          )}
          {delegation.authorized && savedDelegation?.paused && (
            <p role="status" className="text-sm">
              {t('standIn.dingtalk_delegation.saving_paused')}
            </p>
          )}
          {delegation.narrows && (
            <p className="text-sm">{t('standIn.dingtalk_delegation.narrows')}</p>
          )}
          {delegation.widens && (
            <p className="text-sm">{t('standIn.dingtalk_delegation.widens')}</p>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
      {settings.primaryStopped && (
        <p className="text-sm text-text-secondary">
          {t('standIn.dingtalk_delegation.resume_primary')}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {connected && !accountChanged && (
          <Button
            variant="outline"
            className="min-h-11 md:min-h-9"
            data-testid="stand-in-dingtalk-save-scope"
            disabled={!saveAvailable}
            onClick={() => void persist(delegation.authorized ? undefined : 'prepare')}
          >
            {t('standIn.dingtalk_delegation.save_scope')}
          </Button>
        )}
        {granted || (delegation.authorized && connected) ? (
          <Button
            variant="outline"
            className="min-h-11 md:min-h-9"
            data-testid="stand-in-delegation-toggle-pause"
            disabled={blocked || (!granted && (!canEnable || dirty))}
            onClick={() => void persist(granted ? 'pause' : 'resume')}
          >
            {t(
              granted ? 'standIn.dingtalk_delegation.pause' : 'standIn.dingtalk_delegation.resume'
            )}
          </Button>
        ) : (
          <Button
            variant="primary"
            className="min-h-11 md:min-h-9"
            data-testid="stand-in-delegation-enable"
            disabled={!canEnable || accountChanged}
            onClick={() => void persist('enable')}
          >
            {t('standIn.dingtalk_delegation.enable')}
          </Button>
        )}
      </div>
      {authOpen && authTarget && (
        <LocalConnectorAuthDialog
          open
          target={authTarget}
          title={t('standIn.dingtalk_delegation.authorize')}
          onCancel={() => setAuthOpen(false)}
          onSuccess={() => {
            setAuthOpen(false)
            setReadVerified(false)
            setReadDenied(false)
            setProfile(undefined)
            setSwitching(!!savedDelegation?.profile)
            void resource.reload()
          }}
        />
      )}
      <ConfirmDialog
        open={discard}
        destructive
        title={t('standIn.personal.discard_help')}
        description={t('standIn.personal.discard_description')}
        cancelLabel={t('standIn.personal.keep_editing')}
        confirmLabel={t('standIn.personal.discard')}
        confirmTestId="stand-in-dingtalk-discard"
        cancelTestId="stand-in-dingtalk-keep-editing"
        onClose={() => {
          navigation.cancelLeave()
          setDiscard(false)
        }}
        onConfirm={() => {
          setDiscard(false)
          resetDraft()
          navigation.confirmLeave(() => {})
        }}
      />
    </section>
  )
}
