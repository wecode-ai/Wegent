import { dequal } from 'dequal'
import { useImperativeHandle, useRef, useState, type Ref } from 'react'
import type { CollaborationProject } from '@wegent/collaboration'
import {
  newStandInPrimaryRole,
  type PersonalStandInSettings,
  type StandInRole,
} from '@/api/personalStandIn'
import type { StandInExecutorApi } from '@/api/standIn'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { ModelSelector } from '@/components/chat/composer/ModelSelector'
import { isDingTalkSource } from '@/features/collaboration-exp/stand-in/dingtalkDelegation'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import {
  StandInConnectionSettings,
  type StandInConnectionNavigationHandle,
} from './StandInConnectionSettings'
import type { StandInSettingsHandle } from './StandInSettingsPage'
import { useStandInPanelNavigation } from './useStandInPanelNavigation'
import { findStandInProject } from './standInProjects'
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
  dingtalkSourceProblem?: string
  onSelectDevice?(deviceId: string): void
  onSave(value: PersonalStandInSettings): Promise<PersonalStandInSettings | null>
  onReload(): void
}

/** Edits existing connections as drafts and enables the primary identity only on confirmation. */
export function StandInOnboardingSetup({
  configuration,
  api,
  onComplete,
  onBusyChange,
  ref,
}: {
  configuration: StandInOnboardingConfiguration
  api: StandInExecutorApi
  onComplete(openConversation: boolean): Promise<boolean>
  onBusyChange(busy: boolean): void
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
  const [confirming, setConfirming] = useState(false)
  const [detail, setDetail] = useState(false)
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
  const navigation = useStandInPanelNavigation(
    !dequal(initialRole?.connections, role?.connections) ||
      !dequal(initialRole?.collaboration, role?.collaboration),
    busy,
    () => setDiscard(true)
  )
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
  const finish = async (saveConnections: boolean) => {
    if (!baseline || !role || !model || busy) return
    setBusy(true)
    onBusyChange(true)
    setError(null)
    try {
      const next: PersonalStandInSettings = {
        ...baseline,
        primary: {
          prompt: '',
          preferences: '',
          ...baseline.primary,
          enabled: saveConnections || (baseline.primary?.enabled ?? false),
          model,
          modelOptions: role.modelOptions,
          ...(saveConnections && {
            connections: role.connections,
            collaboration: role.collaboration,
          }),
        },
      }
      if (!dequal(next, baseline)) {
        const saved = await configuration.onSave(next)
        if (!saved) return
        setBaseline(saved)
        const savedRole = { ...role, ...saved.primary }
        setRole(savedRole)
        setInitialRole(savedRole)
      }
      await onComplete(!saveConnections)
    } catch (cause) {
      setError(getStandInErrorMessage(cause))
    } finally {
      setBusy(false)
      onBusyChange(false)
    }
  }
  const projectName = (value: { id: string; store: 'local' | 'cloud' }) =>
    findStandInProject(projects, value)?.name ?? value.id
  return (
    <div className="space-y-5" data-testid="stand-in-onboarding-setup">
      {configuration.onSelectDevice && baseline && (
        <label className="flex items-center gap-2 text-sm">
          <span>{t('standIn.device')}</span>
          <StandInDeviceSelect
            value={baseline.executionDeviceId}
            currentDeviceId={localDeviceId}
            devices={configuration.devices ?? []}
            disabled={busy}
            onChange={device => {
              requestLeave(() => configuration.onSelectDevice?.(device))
            }}
          />
        </label>
      )}
      <ol
        className="flex flex-wrap gap-5 text-sm text-text-secondary"
        aria-label={t('standIn.onboarding.steps_label')}
      >
        {['connect_step', 'confirm_step'].map((key, index) => (
          <li
            key={key}
            aria-current={Number(confirming) === index ? 'step' : undefined}
            className={Number(confirming) === index ? 'font-medium text-text-primary' : ''}
          >
            {index + 1}. {t(`standIn.onboarding.${key}`)}
          </li>
        ))}
      </ol>
      {role && baseline && (
        <div className="space-y-2" data-testid="stand-in-onboarding-model">
          <h3 className="text-sm font-medium">{t('standIn.model_label')}</h3>
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
          {models.loading && (
            <p role="status" className="text-sm text-text-secondary">
              {t('workbench.local_model_loading_models_action')}
            </p>
          )}
          <StandInSettingsError
            error={
              models.error ??
              (!models.loading && !model ? t('standIn.errors.model_unavailable') : null)
            }
            retry={{
              testId: 'stand-in-onboarding-model-retry',
              disabled: busy,
              onClick: models.refresh,
            }}
          />
        </div>
      )}
      <p className="text-sm text-text-secondary">
        {t(`standIn.onboarding.${confirming ? 'confirm_help' : 'connect_help'}`)}
      </p>
      {role && baseline ? (
        confirming ? (
          <section className="space-y-4" data-testid="stand-in-onboarding-summary">
            <h3 className="font-medium">{t('standIn.onboarding.selected_apps')}</h3>
            {role.collaboration.enabled && (
              <div className="space-y-1 text-sm">
                <p>{t('standIn.personal.collaboration')}</p>
                <p className="text-text-secondary">
                  {role.collaboration.allProjects
                    ? t('standIn.personal.all_projects')
                    : role.collaboration.projects.map(projectName).join(' · ')}
                </p>
                {!!role.collaboration.excludedProjects.length && (
                  <p className="text-text-secondary">
                    {t('standIn.onboarding.excluded_projects', {
                      names: role.collaboration.excludedProjects.map(projectName).join(' · '),
                    })}
                  </p>
                )}
                {!!role.collaboration.tags.length && (
                  <p className="text-text-secondary">
                    {t('standIn.onboarding.project_tags', {
                      names: role.collaboration.tags.join(' · '),
                    })}
                  </p>
                )}
              </div>
            )}
            {(role.connections ?? []).map(source => (
              <div
                key={JSON.stringify([source.providerId, source.profile, source.kind, source.id])}
                className="text-sm"
              >
                <p>{source.name}</p>
                <p className="text-text-secondary">
                  {isDingTalkSource(source)
                    ? t(
                        source.kind === 'group'
                          ? 'standIn.dingtalk_delegation.group_mentions'
                          : 'standIn.dingtalk_delegation.direct'
                      )
                    : (source.configurationSummary ??
                      t('standIn.workspace.connection_default_configuration'))}
                </p>
              </div>
            ))}
            {role.connections?.some(isDingTalkSource) && (
              <p className="text-sm text-text-secondary">
                {t(
                  baseline.primary?.delegation?.authorized &&
                    !baseline.primary.delegation.paused &&
                    !baseline.primary.delegation.accountInvalidated &&
                    !baseline.lifecycle &&
                    !configuration.dingtalkSourceProblem
                    ? 'standIn.dingtalk_delegation.enabled'
                    : 'standIn.dingtalk_delegation.paused'
                )}
              </p>
            )}
            {!role.collaboration.enabled && !role.connections?.length && (
              <p className="text-sm text-text-secondary">{t('standIn.onboarding.no_apps')}</p>
            )}
            <p className="rounded-lg bg-muted p-3 text-sm text-text-secondary">
              {t('standIn.onboarding.attention_help')}
            </p>
          </section>
        ) : (
          <>
            {detail && (
              <Button
                variant="ghost"
                data-testid="stand-in-onboarding-connections-back"
                className="min-h-11 md:min-h-10"
                disabled={busy}
                onClick={() => connections.current?.back()}
              >
                {t('standIn.onboarding.back_apps')}
              </Button>
            )}
            <StandInConnectionSettings
              ref={connections}
              role={role}
              projects={projects}
              api={api}
              deviceId={baseline.executionDeviceId}
              localDeviceId={localDeviceId}
              disabled={busy || loading}
              hideHeading
              onChange={setRole}
              onDetailViewChange={setDetail}
              dingTalk={{
                saved: baseline.primary ?? { enabled: false, prompt: '', preferences: '' },
                services: configuration.services,
                devices: configuration.devices,
                primaryStopped: Boolean(baseline.lifecycle),
                sourceProblem: configuration.dingtalkSourceProblem,
                modelSelection: {
                  identity:
                    model && !models.errors[model.source === 'cloud' ? 'cloud' : 'native']
                      ? model
                      : null,
                  label: models.selectedModel?.displayName,
                  options: role.modelOptions,
                },
                onBusyChange(saving) {
                  setBusy(saving)
                  onBusyChange(saving)
                },
                async onSave(primary) {
                  const saved = await configuration.onSave({ ...baseline, primary })
                  if (!saved?.primary) return false
                  const savedPrimary = saved.primary
                  const dingTalkRows = (savedPrimary.connections ?? []).filter(isDingTalkSource)
                  const updateRole = (current: StandInRole | null) =>
                    current && {
                      ...current,
                      enabled: savedPrimary.enabled,
                      model: savedPrimary.model,
                      modelOptions: savedPrimary.modelOptions,
                      connections: [
                        ...(current.connections ?? []).filter(row => !isDingTalkSource(row)),
                        ...dingTalkRows,
                      ],
                    }
                  setBaseline(saved)
                  setRole(updateRole)
                  setInitialRole(updateRole)
                  return true
                },
              }}
            />
          </>
        )
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
                  setConfirming(false)
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
      <div className="sticky bottom-0 flex flex-wrap justify-end gap-2 bg-background pt-3">
        <Button
          variant="ghost"
          data-testid="stand-in-onboarding-skip"
          className="min-h-11 md:min-h-10"
          aria-busy={busy}
          disabled={busy || loading || !model}
          onClick={() => requestLeave(() => void finish(false))}
        >
          {t('standIn.onboarding.skip_connections')}
        </Button>
        {confirming && (
          <Button
            variant="ghost"
            data-testid="stand-in-onboarding-back"
            className="min-h-11 md:min-h-10"
            disabled={busy}
            onClick={() => setConfirming(false)}
          >
            {t('standIn.onboarding.back_apps')}
          </Button>
        )}
        <Button
          variant="primary"
          data-testid={confirming ? 'stand-in-onboarding-complete' : 'stand-in-onboarding-continue'}
          className="min-h-11 md:min-h-10"
          aria-busy={busy}
          disabled={busy || !role || loading || (confirming && !model)}
          onClick={() => {
            if (confirming) void finish(true)
            else if (connections.current)
              connections.current.requestLeave(() => setConfirming(true))
            else setConfirming(true)
          }}
        >
          {t(
            busy
              ? 'standIn.onboarding.saving'
              : confirming
                ? 'standIn.onboarding.start'
                : 'standIn.onboarding.continue'
          )}
        </Button>
      </div>
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
