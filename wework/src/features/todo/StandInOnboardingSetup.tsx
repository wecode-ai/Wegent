import { dequal } from 'dequal'
import { ChevronLeft } from 'lucide-react'
import { createPortal } from 'react-dom'
import {
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
  useSyncExternalStore,
  type Ref,
} from 'react'
import { createTagDraft, type CollaborationProject } from '@wegent/collaboration'
import {
  newStandInPrimaryRole,
  primaryWithConnectionMode,
  type PersonalStandInSettings,
  type StandInRole,
} from '@/api/personalStandIn'
import type { StandInExecutorApi } from '@/api/standIn'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { ModelSelector } from '@/components/chat/composer/ModelSelector'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import { findWorkbenchDevice } from '@/lib/workbench-device'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import {
  StandInConnectionSettings,
  type StandInConnectionNavigationHandle,
} from './StandInConnectionSettings'
import {
  connectionConfigurationChanges,
  hasConnectionDraft,
} from './standInConnectionSettingsModel'
import type { StandInSettingsHandle } from './StandInSettingsPage'
import { useStandInPanelNavigation } from './useStandInPanelNavigation'
import type { DeviceInfo } from '@/types/api'
import { StandInDeviceSelect } from './StandInDeviceSelect'
import { StandInSettingsError } from './StandInSettingsLayout'
import { useStandInModels } from './useStandInModels'

export interface StandInOnboardingConfiguration {
  settings: PersonalStandInSettings | null
  loading: boolean
  error: string | null
  projects: CollaborationProject[]
  localDeviceId: string
  devices?: DeviceInfo[]
  services?: WorkbenchServices
  executionDeviceId?: string
  onSelectDevice?(deviceId: string): void | Promise<void>
  onSave(value: PersonalStandInSettings): Promise<PersonalStandInSettings | null>
  onReload(): void
}

/** Edits existing connections as drafts and enables the primary identity only on confirmation. */
export function StandInOnboardingSetup({
  configuration,
  api,
  onComplete,
  onBusyChange,
  backSlot,
  backLabel,
  footerSlot,
  onScopeTitleChange,
  ref,
}: {
  configuration: StandInOnboardingConfiguration
  api: StandInExecutorApi
  onComplete(openConversation: boolean): Promise<boolean>
  onBusyChange(busy: boolean): void
  backSlot?: HTMLElement | null
  backLabel?: string
  footerSlot?: HTMLElement | null
  onScopeTitleChange?(connectionTitle: string | null, pageTitle: string | null): void
  ref?: Ref<Pick<StandInSettingsHandle, 'requestLeave'>>
}) {
  const { t } = useTranslation('common')
  const { settings, projects, localDeviceId, loading } = configuration
  const [baseline, setBaseline] = useState<PersonalStandInSettings | null>(null)
  const [role, setRole] = useState<StandInRole | null>(null)
  const [initialRole, setInitialRole] = useState<StandInRole | null>(null)
  if (!baseline && settings && !loading) {
    setBaseline(settings)
    const empty = newStandInPrimaryRole(settings.executionDeviceId)
    const initial = {
      ...empty,
      ...settings.primary,
      collaboration: settings.primary?.collaboration ?? empty.collaboration,
    }
    setRole(initial)
    setInitialRole(initial)
  }
  const [connectionPage, setConnectionPage] = useState<{
    detail: string | null
    scope: string | null
  }>({ detail: null, scope: null })
  const { detail, scope } = connectionPage
  const detailTitleChanged = useCallback(
    (title: string | null, view: string | null, pageTitle: string | null) => {
      setConnectionPage({ detail: view, scope: pageTitle })
      onScopeTitleChange?.(title, pageTitle)
    },
    [onScopeTitleChange]
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [discard, setDiscard] = useState<'leave' | 'chat' | null>(null)
  const [connectionEditorDirty, setConnectionEditorDirty] = useState(false)
  const [tagDraft] = useState(createTagDraft)
  const tagDraftDirty = useSyncExternalStore(
    tagDraft.subscribe,
    tagDraft.getDirtySnapshot,
    tagDraft.getDirtySnapshot
  )
  const connectionEditPending = connectionEditorDirty || tagDraftDirty
  const models = useStandInModels(
    configuration.services,
    {
      enabled: true,
      prompt: '',
      version: baseline?.version ?? 0,
      executionDeviceId: baseline?.executionDeviceId ?? '',
      model: role?.model,
    },
    'codex',
    Boolean(baseline)
  )
  const model = models.resolve(models.selectedModel)
  const connections = useRef<StandInConnectionNavigationHandle>(null)
  const connectionChanged = Boolean(role && hasConnectionDraft(role, initialRole ?? undefined))
  const currentConnectionChanged = Boolean(
    detail && role && hasConnectionDraft(role, initialRole ?? undefined, detail)
  )
  const navigation = useStandInPanelNavigation(connectionChanged, busy, () => setDiscard('leave'))
  const discardConnections = () => {
    if (!initialRole) return
    setRole(
      current =>
        current && {
          ...current,
          connections: initialRole.connections,
          collaboration: initialRole.collaboration,
        }
    )
  }
  const requestLeave = (action: () => void) => {
    const leave = (discarded?: boolean) => {
      if (discarded) {
        discardConnections()
        action()
      } else navigation.requestLeave(action)
    }
    if (connections.current) connections.current.requestLeave(leave)
    else leave()
  }
  useImperativeHandle(ref, () => ({ requestLeave }))
  const submit = async (target: 'connections' | 'chat') => {
    const chatting = target === 'chat'
    if (!baseline || !role || busy || connectionEditPending) return
    if (chatting ? !model : !detail || !currentConnectionChanged) return
    setBusy(true)
    onBusyChange(true)
    setError(null)
    try {
      const next: PersonalStandInSettings = {
        ...baseline,
        primary: primaryWithConnectionMode(baseline.primary, {
          enabled: false,
          prompt: '',
          preferences: '',
          ...baseline.primary,
          ...(chatting && model
            ? {
                enabled: true,
                model,
                ...(role.modelOptions === undefined ? {} : { modelOptions: role.modelOptions }),
              }
            : {}),
          ...(!chatting && detail
            ? connectionConfigurationChanges(baseline.primary, role, detail)
            : {}),
        }),
      }
      if (!dequal(next, baseline)) {
        const saved = await configuration.onSave(next)
        if (!saved) return
        setBaseline(saved)
        const savedRole = { ...newStandInPrimaryRole(saved.executionDeviceId), ...saved.primary }
        setInitialRole(savedRole)
        setRole(
          !chatting && detail
            ? { ...role, ...connectionConfigurationChanges(role, savedRole, detail) }
            : savedRole
        )
      }
      if (chatting) await onComplete(true)
      else connections.current?.returnToScopeList()
    } catch (cause) {
      setError(getStandInErrorMessage(cause))
    } finally {
      setBusy(false)
      onBusyChange(false)
    }
  }
  const selectedDeviceId = configuration.executionDeviceId ?? baseline?.executionDeviceId
  const selectDevice = async (deviceId: string) => {
    if (!configuration.onSelectDevice || busy || deviceId === selectedDeviceId) return
    setBusy(true)
    onBusyChange(true)
    setError(null)
    try {
      await configuration.onSelectDevice(deviceId)
    } catch (cause) {
      setError(getStandInErrorMessage(cause))
    } finally {
      setBusy(false)
      onBusyChange(false)
    }
  }
  const currentDevice =
    baseline && findWorkbenchDevice(configuration.devices ?? [], baseline.executionDeviceId)
  const editingConnection = Boolean(detail)
  const actions = (!editingConnection || scope || currentConnectionChanged || busy) && (
    <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2 border-t border-border px-5 py-3 md:px-6">
      {connectionChanged && !editingConnection && (
        <p
          role="status"
          data-testid="stand-in-connections-pending"
          className="mr-auto min-w-0 text-sm text-text-secondary"
        >
          {t('standIn.workspace.connection_pending')}
        </p>
      )}
      {scope && (
        <Button
          variant="outline"
          data-testid="stand-in-onboarding-drop-scope"
          disabled={busy}
          className="min-h-11 md:min-h-10"
          onClick={() => connections.current?.back()}
        >
          {t('standIn.personal.discard')}
        </Button>
      )}
      <Button
        data-testid={
          editingConnection
            ? 'stand-in-onboarding-save-connections'
            : 'stand-in-onboarding-complete'
        }
        className="min-h-11 md:min-h-10"
        aria-busy={busy}
        disabled={
          busy ||
          loading ||
          connectionEditPending ||
          (editingConnection ? !currentConnectionChanged : !role || !model)
        }
        onClick={() => {
          if (editingConnection) void submit('connections')
          else if (connectionChanged) setDiscard('chat')
          else void submit('chat')
        }}
      >
        {t(
          busy
            ? 'standIn.onboarding.saving'
            : editingConnection
              ? 'standIn.personal.save_receive_scope'
              : 'standIn.onboarding.start'
        )}
      </Button>
    </div>
  )
  return (
    <div className="space-y-5" data-testid="stand-in-onboarding-setup">
      {!detail && configuration.onSelectDevice && selectedDeviceId && (
        <label className="flex items-center gap-2 text-sm">
          <span>{t('standIn.onboarding.device_label')}</span>
          <StandInDeviceSelect
            value={selectedDeviceId}
            currentDeviceId={localDeviceId}
            devices={configuration.devices ?? []}
            disabled={busy}
            testId={configuration.executionDeviceId ? 'stand-in-onboarding-device' : undefined}
            ariaLabel={t('standIn.onboarding.device_label')}
            onChange={device => {
              requestLeave(() => void selectDevice(device))
            }}
          />
        </label>
      )}
      {!detail && role && baseline && (
        <div className="space-y-2" data-testid="stand-in-onboarding-model">
          <h3 className="text-sm font-medium">{t('standIn.onboarding.model_required')}</h3>
          {!configuration.onSelectDevice && currentDevice && (
            <p className="text-sm text-text-secondary">
              {t('standIn.onboarding.execution_device', { name: currentDevice.name })}
            </p>
          )}
          <ModelSelector
            models={models.models}
            getModelOptionId={models.getModelOptionId}
            selectedModel={models.selectedModel}
            selectedModelOptions={role.modelOptions ?? {}}
            disabled={busy || loading}
            buttonClassName="min-h-11 rounded-md border border-border md:min-h-8"
            menuPlacement="below"
            menuAlign="start"
            menuClassName="z-critical"
            onOpenChange={open => {
              if (open) models.refresh()
            }}
            onSelectModel={next =>
              setRole(
                current => current && { ...current, model: models.resolve(next), modelOptions: {} }
              )
            }
            onSelectModelAndOptions={(next, options) =>
              setRole(
                current =>
                  current && { ...current, model: models.resolve(next), modelOptions: options }
              )
            }
            onSelectModelOption={(key, value) =>
              setRole(
                current =>
                  current && { ...current, modelOptions: { ...current.modelOptions, [key]: value } }
              )
            }
          />
          <p className="text-sm text-text-secondary" data-testid="stand-in-onboarding-model-help">
            {t('standIn.onboarding.model_help')}
          </p>
          {models.loading && !models.models.length && (
            <p role="status" className="text-sm text-text-secondary">
              {t('workbench.local_model_loading_models_action')}
            </p>
          )}
          <StandInSettingsError
            error={
              models.error ??
              (!models.loading && !models.models.length ? t('standIn.onboarding.no_models') : null)
            }
            retry={{
              testId: 'stand-in-onboarding-model-retry',
              disabled: busy,
              onClick: models.refresh,
            }}
          />
        </div>
      )}
      {role && baseline ? (
        <section className={detail ? 'space-y-3' : 'space-y-3 border-t border-border pt-4'}>
          {!detail && (
            <div>
              <h3 className="text-sm font-medium">
                {t('standIn.onboarding.connections_optional')}
              </h3>
            </div>
          )}
          {detail &&
            backSlot &&
            createPortal(
              <Button
                variant="ghost"
                size="sm"
                className="min-h-11 max-w-full gap-1.5 px-2 text-sm text-text-primary md:min-h-9"
                data-testid="stand-in-onboarding-connections-back"
                disabled={busy}
                onClick={() => connections.current?.back()}
              >
                <ChevronLeft className="size-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0 whitespace-normal text-left">{backLabel}</span>
              </Button>,
              backSlot
            )}
          <StandInConnectionSettings
            ref={connections}
            role={role}
            savedConfiguration={initialRole ?? undefined}
            projects={projects}
            api={api}
            deviceId={baseline.executionDeviceId}
            localDeviceId={localDeviceId}
            disabled={busy || loading}
            onScheduleDirtyChange={setConnectionEditorDirty}
            tagDraft={tagDraft}
            hideHeading
            showPendingStatus={false}
            onChange={setRole}
            onDetailTitleChange={detailTitleChanged}
          />
        </section>
      ) : loading ? (
        <p role="status">{t('standIn.onboarding.loading')}</p>
      ) : null}
      {(error || configuration.error) && (
        <div role="alert" className="text-sm text-error">
          <p>{error || configuration.error}</p>
          {configuration.error && (
            <Button
              data-testid="stand-in-onboarding-settings-retry"
              className="min-h-11 min-w-11 md:min-h-10"
              disabled={busy || loading}
              onClick={() =>
                requestLeave(() => {
                  setBaseline(null)
                  setRole(null)
                  setInitialRole(null)
                  configuration.onReload()
                })
              }
            >
              {t('standIn.reload')}
            </Button>
          )}
        </div>
      )}
      {footerSlot ? createPortal(actions, footerSlot) : actions}
      <ConfirmDialog
        open={discard !== null}
        destructive
        title={t(
          discard === 'chat'
            ? 'standIn.onboarding.discard_connections'
            : 'standIn.personal.discard_help'
        )}
        description={t(
          discard === 'chat'
            ? 'standIn.onboarding.keep_saved_scopes'
            : 'standIn.personal.discard_description'
        )}
        cancelLabel={t('standIn.personal.keep_editing')}
        confirmLabel={t(
          discard === 'chat' ? 'standIn.onboarding.discard_and_start' : 'standIn.personal.discard'
        )}
        confirmTestId="stand-in-onboarding-discard"
        cancelTestId="stand-in-onboarding-keep-editing"
        onClose={() => {
          navigation.cancelLeave()
          setDiscard(null)
        }}
        onConfirm={() => {
          setDiscard(null)
          discardConnections()
          if (discard === 'chat') void submit('chat')
          else navigation.confirmLeave(() => {})
        }}
      />
    </div>
  )
}
