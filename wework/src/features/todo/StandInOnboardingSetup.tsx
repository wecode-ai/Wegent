import { dequal } from 'dequal'
import { ChevronLeft } from 'lucide-react'
import { createPortal } from 'react-dom'
import { useCallback, useImperativeHandle, useRef, useState, type Ref } from 'react'
import type { CollaborationProject } from '@wegent/collaboration'
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
import { hasConnectionDraft } from './standInConnectionSettingsModel'
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
  footerSlot,
  onScopeTitleChange,
  ref,
}: {
  configuration: StandInOnboardingConfiguration
  api: StandInExecutorApi
  onComplete(openConversation: boolean): Promise<boolean>
  onBusyChange(busy: boolean): void
  backSlot?: HTMLElement | null
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
  const [detail, setDetail] = useState<string | null>(null)
  const detailTitleChanged = useCallback(
    (title: string | null, view: string | null, pageTitle: string | null) => {
      setDetail(view)
      onScopeTitleChange?.(title, pageTitle)
    },
    [onScopeTitleChange]
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [discard, setDiscard] = useState(false)
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
  const showDraftNotice = detail
    ? Boolean(role && hasConnectionDraft(role, initialRole ?? undefined, detail))
    : connectionChanged
  const navigation = useStandInPanelNavigation(connectionChanged, busy, () => setDiscard(true))
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
  /** Persist settings before completion, retaining the saved version for completion-only retries. */
  const finish = async () => {
    if (!baseline || !role || !model || busy) return
    setBusy(true)
    onBusyChange(true)
    setError(null)
    try {
      const next: PersonalStandInSettings = {
        ...baseline,
        primary: primaryWithConnectionMode(baseline.primary, {
          prompt: '',
          preferences: '',
          ...baseline.primary,
          enabled: true,
          model,
          ...(role.modelOptions === undefined ? {} : { modelOptions: role.modelOptions }),
          ...(role.connections === undefined ? {} : { connections: role.connections }),
          collaboration: role.collaboration,
        }),
      }
      if (!dequal(next, baseline)) {
        const saved = await configuration.onSave(next)
        if (!saved) return
        setBaseline(saved)
        const savedRole = { ...role, ...saved.primary }
        setRole(savedRole)
        setInitialRole(savedRole)
      }
      await onComplete(true)
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
  const actions = (!detail || showDraftNotice) && (
    <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2 border-t border-border px-5 py-3 md:px-6">
      {showDraftNotice && (
        <p
          role="status"
          data-testid="stand-in-connections-pending"
          className="mr-auto min-w-0 text-sm text-text-secondary"
        >
          {t(
            detail
              ? 'standIn.onboarding.connections_draft_retained'
              : 'standIn.onboarding.connections_draft_apply'
          )}
        </p>
      )}
      {!detail && (
        <Button
          data-testid="stand-in-onboarding-complete"
          className="min-h-11 md:min-h-10"
          aria-busy={busy}
          disabled={busy || loading || !role || !model}
          onClick={() => void finish()}
        >
          {t(busy ? 'standIn.onboarding.saving' : 'standIn.onboarding.start')}
        </Button>
      )}
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
                size="icon"
                data-testid="stand-in-onboarding-connections-back"
                aria-label={t('standIn.personal.back')}
                title={t('standIn.personal.back')}
                disabled={busy}
                onClick={() => connections.current?.back()}
              >
                <ChevronLeft aria-hidden="true" />
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
                navigation.requestLeave(() => {
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
        open={discard}
        destructive
        title={t('standIn.personal.discard_help')}
        description={t('standIn.personal.discard_description')}
        cancelLabel={t('standIn.personal.keep_editing')}
        confirmLabel={t('standIn.personal.discard')}
        confirmTestId="stand-in-onboarding-discard"
        cancelTestId="stand-in-onboarding-keep-editing"
        onClose={() => {
          navigation.cancelLeave()
          setDiscard(false)
        }}
        onConfirm={() => {
          setDiscard(false)
          discardConnections()
          navigation.confirmLeave(() => {})
        }}
      />
    </div>
  )
}
