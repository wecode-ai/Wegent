import type { DingTalkDelegation, DingTalkDelegationAccount } from '@/api/personalStandIn'
import { newStandInPrimaryRole } from '@/api/personalStandIn'
import type {
  ConnectionProviderDescriptor,
  ConnectionReadiness,
  ConnectionReadinessSource,
  StandInExecutorApi,
} from '@/api/standIn'
import { ModelSelector } from '@/components/chat/composer/ModelSelector'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { LocalConnectorAuthDialog } from '@/components/plugins/LocalConnectorAuthDialog'
import { Button } from '@/components/ui/button'
import { useOptionalAppUpdate } from '@/features/app-update/app-update-context'
import { formatAppUpdateProgress } from '@/features/app-update/app-update-progress-copy'
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
import { useFocusRequest } from '@wegent/collaboration/dom-events'
import { dequal } from 'dequal'
import {
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type Ref,
} from 'react'
import { StandInSourceConnections } from './StandInSourceConnections'
import { DINGTALK_PROVIDER } from './standInDingTalk'
import { useStandInModels } from './useStandInModels'
import { useStandInPanelNavigation } from './useStandInPanelNavigation'

const defaultTemplates = { documentLink: true, timeLocation: true, standardProcess: true }
const templateKeys = Object.keys(defaultTemplates) as Array<keyof typeof defaultTemplates>

export interface StandInDingTalkSettings {
  delegation?: DingTalkDelegation
  model?: RunnerModelIdentity | null
  modelOptions?: WorkspaceStandInSettings['modelOptions']
  modelSelection?: {
    identity: RunnerModelIdentity | null
    label?: string | null
    options?: WorkspaceStandInSettings['modelOptions']
  }
  services?: WorkbenchServices
  devices?: DeviceInfo[]
  replacesLegacy?: boolean
  primaryAvailable: boolean
  sourceProblem?: string
  onSave(
    delegation: DingTalkDelegation,
    model?: RunnerModelIdentity,
    options?: WorkspaceStandInSettings['modelOptions']
  ): Promise<boolean>
  onBusyChange?(busy: boolean): void
}

export interface StandInDingTalkNavigation {
  requestLeave(action: () => void): void
}

function sameAccount(a?: DingTalkDelegationAccount, b?: DingTalkDelegationAccount) {
  return Boolean(
    a &&
    b &&
    a.profile === b.profile &&
    a.accountId === b.accountId &&
    a.organizationId === b.organizationId
  )
}

function newSelection(account: DingTalkDelegationAccount): DingTalkDelegation {
  return { account, enabled: false, sources: [], templates: defaultTemplates }
}

function selectedSources(value: DingTalkDelegation): ConnectionReadinessSource[] {
  return value.sources.flatMap(({ id, kind }) =>
    kind === 'direct' || kind === 'group' ? [{ id, kind }] : []
  )
}

/** The selected-source connection uses the same editor and native auth as other providers. */
export function StandInDingTalkDelegation({
  settings,
  api,
  provider,
  deviceId,
  localDeviceId,
  disabled,
  onBack,
  ref,
}: {
  settings: StandInDingTalkSettings
  api: StandInExecutorApi
  provider?: ConnectionProviderDescriptor
  deviceId: string
  localDeviceId: string
  disabled: boolean
  onBack?(): void
  ref?: Ref<StandInDingTalkNavigation>
}) {
  const { t } = useTranslation('common')
  const heading = useRef<HTMLHeadingElement>(null)
  useFocusRequest(heading)
  const saved = settings.delegation
  const device = settings.devices?.find(candidate => candidate.device_id === deviceId)
  const local = deviceId === localDeviceId && device?.status !== 'offline'
  const update = useOptionalAppUpdate()
  const updatePending =
    update?.status === 'installing' || update?.downloadProgress?.phase === 'ready'
  const updateFailed = update?.downloadProgress?.phase === 'failed'
  const updating = update?.status === 'downloading' && !updatePending && !updateFailed
  const [switching, setSwitching] = useState(false)
  const [profile, setProfile] = useState<string>()
  const [authOpen, setAuthOpen] = useState(false)
  const [draft, setDraft] = useState<DingTalkDelegation>()
  const [selectedModel, setSelectedModel] = useState<RunnerModelIdentity | null>()
  const [modelOptions, setModelOptions] = useState<WorkspaceStandInSettings['modelOptions']>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [verified, setVerified] = useState(false)
  const [permissionDenied, setPermissionDenied] = useState(false)
  const [discard, setDiscard] = useState(false)
  const requestedProfile = profile ?? (switching ? undefined : saved?.account.profile)
  const resource = useMemo(
    () =>
      createAsyncResource(JSON.stringify([deviceId, requestedProfile]), () =>
        api.connectionReadiness(deviceId, DINGTALK_PROVIDER, requestedProfile)
      ),
    [api, deviceId, requestedProfile]
  )
  const result = useSyncExternalStore(
    local ? resource.subscribe : subscribeIdleResource,
    resource.getSnapshot,
    getIdleResourceSnapshot
  )
  const readiness = result.status === 'ready' ? result.data : undefined
  const identity = readiness?.identity
  const displayedAccount = identity ?? saved?.account
  const accountChanged = Boolean(saved && identity && !sameAccount(saved.account, identity))
  const connected = readiness?.status === 'ready' && !!identity && !switching
  const active = Boolean(saved?.enabled && !accountChanged)
  const readDenied =
    permissionDenied ||
    readiness?.status === 'permissions_required' ||
    (active && settings.sourceProblem === 'dingtalk_permissions_required')
  const values =
    identity && !accountChanged
      ? draft && sameAccount(draft.account, identity)
        ? draft
        : (saved ?? newSelection(identity))
      : undefined
  const baseRole = newStandInPrimaryRole(deviceId)
  const models = useStandInModels(
    settings.services,
    { ...baseRole, model: selectedModel ?? settings.model },
    'codex',
    local && !settings.modelSelection
  )
  const model = settings.modelSelection
    ? settings.modelSelection.identity
    : models.resolve(models.selectedModel)
  const modelLabel =
    settings.modelSelection?.label ?? models.selectedModel?.displayName ?? model?.model_id
  const review = Boolean(
    saved?.sources.length && !draft && (active || dequal(model, settings.model))
  )
  const canSave =
    !disabled && !busy && local && connected && !!model && !updatePending && !updateFailed
  const authTarget = readiness?.authTarget ?? provider?.authTarget
  const navigation = useStandInPanelNavigation(
    Boolean((draft && !dequal(draft, saved)) || selectedModel !== undefined || modelOptions),
    busy || authOpen,
    () => setDiscard(true)
  )
  useImperativeHandle(ref, () => ({ requestLeave: navigation.requestLeave }))
  const persist = async (
    next: DingTalkDelegation,
    action: 'state' | 'scope' | 'enable' = 'state'
  ) => {
    if (busy || disabled) return false
    setBusy(true)
    settings.onBusyChange?.(true)
    setError(null)
    setPermissionDenied(false)
    try {
      if (action === 'enable') {
        const access = await api.connectionReadiness(
          deviceId,
          DINGTALK_PROVIDER,
          next.account.profile,
          selectedSources(next)
        )
        if (!hasReadAccess(access, next.account)) {
          setPermissionDenied(access.status === 'permissions_required')
          setError(
            t(
              access.status === 'permissions_required'
                ? 'standIn.dingtalk_delegation.permissions_required'
                : 'standIn.dingtalk_delegation.connection_failed'
            )
          )
          if (access.status !== 'permissions_required') void resource.reload()
          return false
        }
        setVerified(true)
      }
      const saved = await settings.onSave(
        next,
        action === 'state' ? undefined : (model ?? undefined),
        action === 'state' ? undefined : (settings.modelSelection?.options ?? modelOptions)
      )
      if (!saved) {
        setError(t('standIn.dingtalk_delegation.save_failed'))
        return false
      }
      setDraft(undefined)
      setSelectedModel(undefined)
      setModelOptions(undefined)
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
    if (saved?.enabled && !(await persist({ ...saved, enabled: false }))) return
    setVerified(false)
    setPermissionDenied(false)
    setProfile(undefined)
    setSwitching(true)
  }
  const setValues = (next: DingTalkDelegation) => {
    setVerified(false)
    setPermissionDenied(false)
    setDraft(next)
  }
  const repair = (path: string) => navigation.requestLeave(() => navigateTo(path))
  let connectionStatus = 'checking'
  if (!local) connectionStatus = 'offline'
  else if (switching) connectionStatus = 'choose_account'
  else if (
    readiness?.status === 'auth_required' ||
    (active && settings.sourceProblem === 'connector_auth_required')
  )
    connectionStatus = saved ? 'expired' : 'disconnected'
  else if (readiness?.status === 'identity_required') connectionStatus = 'choose_account'
  else if (readiness?.status === 'permissions_required' || permissionDenied)
    connectionStatus = 'connected'
  else if (readiness?.status === 'ready') connectionStatus = 'connected'
  else if (result.status === 'error' || readiness?.status === 'error')
    connectionStatus = 'connection_failed'

  return (
    <section className="space-y-4" data-testid="stand-in-dingtalk-delegation">
      <div className="space-y-1">
        <h3 ref={heading} tabIndex={-1} className="font-medium">
          {t('standIn.dingtalk_delegation.title')}
        </h3>
        <p className="text-sm text-text-secondary">{t('standIn.dingtalk_delegation.scope_help')}</p>
        {!saved && settings.replacesLegacy && (
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
        <dt className="text-text-secondary">{t('standIn.dingtalk_delegation.account')}</dt>
        <dd data-testid="stand-in-dingtalk-account">
          {displayedAccount && !switching
            ? [displayedAccount.accountName, displayedAccount.organizationName]
                .filter(Boolean)
                .join(' · ')
            : t('standIn.dingtalk_delegation.no_account')}
        </dd>
        <dt className="text-text-secondary">{t('standIn.dingtalk_delegation.connection')}</dt>
        <dd role="status">{t(`standIn.dingtalk_delegation.${connectionStatus}`)}</dd>
        <dt className="text-text-secondary">{t('standIn.dingtalk_delegation.read_access')}</dt>
        <dd>
          {t(
            readDenied
              ? 'standIn.dingtalk_delegation.permissions_required'
              : verified || (connected && active && !settings.sourceProblem)
                ? 'standIn.dingtalk_delegation.read_verified'
                : 'standIn.dingtalk_delegation.read_pending'
          )}
        </dd>
        <dt className="text-text-secondary">{t('standIn.dingtalk_delegation.delegation')}</dt>
        <dd>
          {t(active ? 'standIn.dingtalk_delegation.enabled' : 'standIn.dingtalk_delegation.paused')}
        </dd>
        {readiness?.component && (
          <>
            <dt className="text-text-secondary">{t('standIn.dingtalk_delegation.component')}</dt>
            <dd>
              {t(`standIn.dingtalk_delegation.${readiness.component.source}`)} ·{' '}
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
            disabled={disabled || busy || result.status === 'loading'}
            onClick={() => {
              setVerified(false)
              setPermissionDenied(false)
              setError(null)
              void resource.reload()
            }}
          >
            {t('standIn.reload')}
          </Button>
          {connected && !accountChanged && !switching && (
            <Button
              variant="outline"
              className="min-h-11 md:min-h-9"
              data-testid="stand-in-dingtalk-switch-account"
              disabled={disabled || busy}
              onClick={() =>
                navigation.requestLeave(() => {
                  setDraft(undefined)
                  void switchAccount()
                })
              }
            >
              {t('standIn.dingtalk_delegation.switch_account')}
            </Button>
          )}
          {authTarget &&
            (switching ||
              connectionStatus === 'expired' ||
              readiness?.status === 'auth_required' ||
              readiness?.status === 'identity_required') && (
              <Button
                variant="outline"
                className="min-h-11 md:min-h-9"
                data-testid="stand-in-dingtalk-authorize"
                disabled={disabled || busy}
                onClick={() => setAuthOpen(true)}
              >
                {t('standIn.workspace.connect_source', {
                  name: provider?.displayName ?? t('standIn.dingtalk_delegation.provider'),
                })}
              </Button>
            )}
        </div>
      )}
      {(updating || updatePending || updateFailed || readiness?.status === 'error') && (
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
          readiness?.status === 'identity_required' ||
          readiness?.status === 'auth_required') && (
          <div className="flex flex-wrap gap-2">
            {readiness?.candidates?.map(candidate => (
              <Button
                key={candidate.profile}
                variant="outline"
                className="min-h-11 md:min-h-9"
                data-testid={`stand-in-dingtalk-select-account-${candidate.profile}`}
                disabled={disabled || busy}
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
      {connected && accountChanged && identity && (
        <div className="space-y-2 text-sm">
          <p>{t('standIn.dingtalk_delegation.account_changed')}</p>
          <Button
            className="min-h-11 md:min-h-9"
            data-testid="stand-in-dingtalk-confirm-account"
            disabled={busy || disabled}
            onClick={() => void persist(newSelection(identity))}
          >
            {t('standIn.dingtalk_delegation.confirm_account')}
          </Button>
        </div>
      )}
      {connected && !accountChanged && values && (
        <>
          <div className="space-y-2 text-sm">
            <h4 className="font-medium">{t('standIn.model_label')}</h4>
            {settings.modelSelection || active ? (
              <p>{modelLabel ?? t('standIn.errors.model_unavailable')}</p>
            ) : (
              <ModelSelector
                models={models.models}
                getModelOptionId={models.getModelOptionId}
                selectedModel={models.selectedModel}
                selectedModelOptions={modelOptions ?? settings.modelOptions ?? {}}
                disabled={busy || disabled || models.loading}
                buttonClassName="min-h-11 rounded-md border border-border md:min-h-8"
                menuPlacement="below"
                menuAlign="start"
                menuClassName="z-critical"
                onSelectModel={entry => {
                  setSelectedModel(models.resolve(entry))
                  setModelOptions({})
                }}
                onSelectModelAndOptions={(entry, options) => {
                  setSelectedModel(models.resolve(entry))
                  setModelOptions(options)
                }}
                onSelectModelOption={(key, value) =>
                  setModelOptions(previous => ({
                    ...settings.modelOptions,
                    ...previous,
                    [key]: value,
                  }))
                }
                onOpenChange={open => {
                  if (open) models.refresh()
                }}
              />
            )}
            {model && (
              <p className="text-xs text-text-secondary">
                {t(
                  model.source === 'cloud'
                    ? 'standIn.dingtalk_delegation.cloud_inference'
                    : 'standIn.dingtalk_delegation.native_inference'
                )}
              </p>
            )}
            {!model && (
              <Button
                variant="ghost"
                className="min-h-11 md:min-h-9"
                data-testid="stand-in-dingtalk-open-models"
                disabled={busy}
                onClick={() => repair('/settings/personal/models')}
              >
                {t('standIn.dingtalk_delegation.open_models')}
              </Button>
            )}
          </div>
          {active || review ? (
            <ul aria-label={t('standIn.workspace.connection_scope')} className="space-y-1 text-sm">
              {values.sources.map(source => (
                <li key={`${source.kind}:${source.id}`}>
                  {source.name} ·{' '}
                  {t(
                    source.kind === 'group'
                      ? 'standIn.workspace.group_mentions'
                      : 'standIn.dingtalk_delegation.private_messages'
                  )}
                </li>
              ))}
            </ul>
          ) : (
            provider && (
              <StandInSourceConnections
                provider={{ ...provider, availability: { status: 'ready' }, authTarget }}
                role={{ ...baseRole, connections: values.sources }}
                api={api}
                deviceId={deviceId}
                localDeviceId={localDeviceId}
                lockedProfile={values.account.profile}
                disabled={disabled || busy}
                onChange={next => setValues({ ...values, sources: next.connections ?? [] })}
                onReady={() => void resource.reload()}
              />
            )
          )}
          <fieldset disabled={busy || disabled || active || review} className="space-y-1 text-sm">
            <legend className="font-medium">{t('standIn.dingtalk_delegation.reply_topics')}</legend>
            <p className="py-1 text-text-secondary">
              {t('standIn.dingtalk_delegation.reply_help')}
            </p>
            {templateKeys.map(key => (
              <label key={key} className="flex min-h-11 items-center gap-2 md:min-h-8">
                <Checkbox
                  checked={values.templates[key]}
                  disabled={busy || disabled || active || review}
                  data-testid={`stand-in-dingtalk-template-${key}`}
                  onCheckedChange={checked =>
                    setValues({
                      ...values,
                      templates: { ...values.templates, [key]: checked === true },
                    })
                  }
                />
                {t(`standIn.dingtalk_delegation.${key}`)}
              </label>
            ))}
          </fieldset>
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
      {!settings.primaryAvailable && (
        <p className="text-sm text-text-secondary">
          {t('standIn.dingtalk_delegation.resume_primary')}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {onBack && (
          <Button
            variant="ghost"
            className="min-h-11 md:min-h-9"
            data-testid="stand-in-dingtalk-setup-back"
            disabled={busy}
            onClick={() => navigation.requestLeave(onBack)}
          >
            {t('standIn.onboarding.back_apps')}
          </Button>
        )}
        {saved?.enabled && (
          <Button
            variant="outline"
            className="min-h-11 md:min-h-9"
            data-testid="stand-in-dingtalk-pause"
            disabled={busy || disabled}
            onClick={() => void persist({ ...saved, enabled: false })}
          >
            {t('standIn.dingtalk_delegation.pause')}
          </Button>
        )}
        {!active && values && review && (
          <Button
            variant="ghost"
            className="min-h-11 md:min-h-9"
            data-testid="stand-in-dingtalk-edit-scope"
            disabled={busy || disabled}
            onClick={() => setValues(values)}
          >
            {t('standIn.dingtalk_delegation.edit_scope')}
          </Button>
        )}
        {!active && values && !review && (
          <Button
            className="min-h-11 md:min-h-9"
            data-testid="stand-in-dingtalk-save-scope"
            disabled={!canSave || !values.sources.length}
            onClick={() => void persist({ ...values, enabled: false }, 'scope')}
          >
            {t('standIn.dingtalk_delegation.save_scope')}
          </Button>
        )}
        {!active && values && review && (
          <Button
            variant="primary"
            className="min-h-11 md:min-h-9"
            data-testid="stand-in-dingtalk-enable"
            disabled={!canSave || !settings.primaryAvailable}
            onClick={() => void persist({ ...values, enabled: true }, 'enable')}
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
            setVerified(false)
            setPermissionDenied(false)
            if (saved) {
              setProfile(undefined)
              setSwitching(true)
            }
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
          setDraft(undefined)
          setSelectedModel(undefined)
          setModelOptions(undefined)
          navigation.confirmLeave(() => {})
        }}
      />
    </section>
  )
}

function hasReadAccess(result: ConnectionReadiness, expected: DingTalkDelegationAccount) {
  return (
    result.status === 'ready' &&
    result.permissions?.read === 'verified' &&
    sameAccount(result.identity, expected)
  )
}
