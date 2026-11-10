import { StandInImConnections } from './StandInImConnections'
import { useStandInPanelNavigation } from './useStandInPanelNavigation'
import { getStandInErrorMessage, reportStandInError } from '@/lib/stand-in-error-message'
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
  type ReactNode,
} from 'react'
import { dequal } from 'dequal'
import {
  connectionChangeEnablesIdentity,
  newStandInRole,
  type PersonalStandInSettings,
} from '@/api/personalStandIn'
import type { StandInExecutorApi } from '@/api/standIn'
import type { CollaborationProject } from '@wegent/collaboration'
import {
  StandInConnectionSettings,
  type StandInConnectionNavigationHandle,
} from './StandInConnectionSettings'
import {
  StandInSettingsHeader,
  StandInSettingsActions,
  StandInSettingsEntry,
} from './StandInSettingsLayout'
import { StandInComposer } from './StandInComposer'
import { StandInDeviceSelect } from './StandInDeviceSelect'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { DeviceInfo, RuntimeWorkListResponse } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import { useDialogKeyboard } from '@/hooks/useDialogKeyboard'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import type { StandInSettingsHandle } from './StandInSettingsPage'

/** Edit the primary identity and its connections on the explicitly selected Executor. */
export function StandInPrimaryProfile({
  settings,
  saving,
  error,
  onSave,
  onClose,
  ref,
  api,
  localDeviceId,
  projects,
  services,
  devices,
  onSelectDevice,
  initialCalendar = false,
  onCalendarViewChange,
  onReload,
  management,
  footerLeading,
}: {
  settings: PersonalStandInSettings
  saving: boolean
  error: string | null
  onSave(settings: PersonalStandInSettings): Promise<void>
  onClose(): void
  ref?: Ref<StandInSettingsHandle>
  api?: StandInExecutorApi
  localDeviceId: string
  projects: CollaborationProject[]
  services: WorkbenchServices
  devices: DeviceInfo[]
  onSelectDevice(deviceId: string): void
  initialCalendar?: boolean
  onCalendarViewChange?(open: boolean): void
  onReload?(): void
  management?: ReactNode
  footerLeading?: ReactNode
}) {
  const { t } = useTranslation('common')
  const saved = settings.primary ?? { enabled: true, prompt: '', preferences: '' }
  const defaultCollaboration = {
    ...newStandInRole(settings.executionDeviceId).collaboration,
    policy: { automatic: true, askBeforeAct: true, immediate: false },
  }
  // Consolidate the old two-field profile without dropping either saved value.
  const original = {
    ...saved,
    collaboration: saved.collaboration ?? defaultCollaboration,
    calendar: saved.calendar,
    connections: saved.connections ?? [],
    prompt: '',
    preferences: [saved.prompt, saved.preferences].filter(Boolean).join('\n\n'),
  }
  const [draft, setDraft] = useState(original)
  const [baseline, setBaseline] = useState(original)
  if (!dequal(baseline, original)) {
    setBaseline(original)
    if (dequal(draft, baseline)) setDraft(original)
  }
  const [connections, setConnections] = useState(initialCalendar)
  const [calendarEntry, setCalendarEntry] = useState(initialCalendar)
  const [calendarOpen, setCalendarOpen] = useState(initialCalendar)
  const [connectionDetailOpen, setConnectionDetailOpen] = useState(initialCalendar)
  const [connectionTitle, setConnectionTitle] = useState<string | null>(null)
  const calendarViewChanged = useCallback(
    (open: boolean) => {
      setCalendarOpen(open)
      onCalendarViewChange?.(open)
    },
    [onCalendarViewChange]
  )
  const [discard, setDiscard] = useState(false)
  const [runtimeWork, setRuntimeWork] = useState<RuntimeWorkListResponse | null>(null)
  const [runtimeError, setRuntimeError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    if (!services.runtimeWorkApi) return
    let active = true
    void services.runtimeWorkApi
      .listRuntimeWork({ deviceId: settings.executionDeviceId })
      .then(value => {
        if (active) {
          setRuntimeWork(value)
          setRuntimeError(null)
        }
      })
      .catch(cause => {
        if (active) {
          reportStandInError('load_environment', cause, settings.executionDeviceId)
          setRuntimeError(getStandInErrorMessage(cause, 'load_environment_failed'))
        }
      })
    return () => {
      active = false
    }
  }, [services.runtimeWorkApi, settings.executionDeviceId, reload])
  const [scheduleDirty, setScheduleDirty] = useState(false)
  const dirty = !dequal(original, draft) || scheduleDirty

  const role = {
    ...newStandInRole(settings.executionDeviceId, '@primary'),
    ...draft,
  }
  const navigation = useStandInPanelNavigation(!dequal(original, draft), saving, () =>
    setDiscard(true)
  )
  const connectionRef = useRef<StandInConnectionNavigationHandle>(null)
  const requestLeave = (action: () => void) => {
    if (connectionRef.current)
      connectionRef.current.requestLeave(() => navigation.requestLeave(action))
    else navigation.requestLeave(action)
  }
  const close = () => requestLeave(onClose)
  const dialogRef = useDialogKeyboard<HTMLDivElement>(close, !discard)
  useImperativeHandle(ref, () => ({ requestClose: close, requestLeave }))
  return (
    <div
      ref={dialogRef}
      className={`flex h-full min-h-0 flex-col px-5 ${calendarOpen ? 'overflow-hidden' : 'overflow-y-auto'}`}
      data-testid="stand-in-primary-profile"
    >
      <StandInSettingsHeader
        path={[
          {
            label: t('standIn.workspace.primary_profile'),
            testId: 'stand-in-path-settings',
            onClick: connections
              ? () => {
                  const back = () => {
                    setCalendarEntry(false)
                    setConnections(false)
                  }
                  if (connectionRef.current) connectionRef.current.requestLeave(back)
                  else back()
                }
              : undefined,
          },
          ...(connections
            ? [
                {
                  label: t('standIn.workspace.connections'),
                  testId: 'stand-in-path-connections',
                  onClick: connectionDetailOpen ? () => connectionRef.current?.back() : undefined,
                },
              ]
            : []),
          ...(connections && connectionTitle
            ? [{ label: connectionTitle, testId: 'stand-in-path-source' }]
            : []),
        ]}
        title={t(
          connections ? 'standIn.workspace.connections' : 'standIn.workspace.primary_profile'
        )}
        disabled={saving}
        back={
          connections
            ? {
                testId: connectionDetailOpen
                  ? 'stand-in-connections-back'
                  : 'stand-in-primary-back-to-settings',
                onClick: () => {
                  if (connectionDetailOpen) {
                    connectionRef.current?.back()
                    return
                  }
                  setCalendarEntry(false)
                  setConnections(false)
                },
              }
            : { testId: 'stand-in-primary-back', onClick: close }
        }
        close={{ testId: 'stand-in-primary-profile-close', onClick: close }}
      />
      {!connections && (
        <>
          <label className="grid gap-2">
            <span>{t('standIn.workspace.profile_instructions')}</span>
            <div className="rounded-lg border border-solid border-border bg-background focus-within:border-text-tertiary focus-within:ring-1 focus-within:ring-focus/20">
              <textarea
                data-testid="stand-in-preferences"
                value={draft.preferences}
                disabled={saving}
                onChange={event => setDraft({ ...draft, preferences: event.target.value })}
                placeholder={t('standIn.workspace.profile_instructions_placeholder')}
                rows={5}
                className="block w-full resize-y appearance-none rounded-lg border-0 bg-transparent p-3 text-sm outline-none"
              />
            </div>
            <span className="text-xs text-text-muted">
              {t('standIn.workspace.profile_instructions_help')}
            </span>
          </label>
          <StandInImConnections
            services={services}
            devices={devices}
            deviceId={settings.executionDeviceId}
            disabled={saving}
          />
          <div className="mt-6">
            <StandInSettingsEntry
              label={t('standIn.workspace.connections')}
              description={t('standIn.workspace.connections_help')}
              testId="stand-in-primary-connections-open"
              disabled={saving}
              onClick={() => setConnections(true)}
            />
          </div>
        </>
      )}
      {connections && (
        <div className={calendarOpen ? 'flex min-h-0 flex-1 flex-col' : 'flex flex-1 flex-col'}>
          <StandInConnectionSettings
            ref={connectionRef}
            onNavigate={navigation.requestLeave}
            hideHeading
            initialCalendar={calendarEntry}
            onCalendarViewChange={calendarViewChanged}
            onDetailViewChange={setConnectionDetailOpen}
            onDetailTitleChange={setConnectionTitle}
            role={role}
            savedConfiguration={{
              connections: original.connections,
              collaboration: original.collaboration,
              calendar: original.calendar,
            }}
            scheduling={{ userId: settings.userId, roleId: '@primary' }}
            onScheduleDirtyChange={setScheduleDirty}
            projects={projects}
            api={api}
            deviceId={settings.executionDeviceId}
            localDeviceId={localDeviceId}
            disabled={saving}
            onChange={value =>
              setDraft({
                ...draft,
                enabled: original.enabled || connectionChangeEnablesIdentity(original, value),
                collaboration: value.collaboration,
                calendar: value.calendar,
                connections: value.connections ?? [],
              })
            }
          />
        </div>
      )}
      {!connections && (
        <section
          className="mt-6 space-y-3 border-t border-border pt-5"
          data-testid="stand-in-primary-execution"
        >
          <div>
            <h3 className="font-medium">{t('standIn.workspace.execution_settings')}</h3>
            <p className="mt-1 text-xs text-text-muted">
              {t('standIn.workspace.execution_settings_help')}
            </p>
          </div>
          <StandInComposer
            draft={role}
            showPrompt={false}
            onChange={update => {
              setDraft(current => {
                const next = typeof update === 'function' ? update({ ...role, ...current }) : update
                return {
                  ...current,
                  model: next.model,
                  modelOptions: next.modelOptions,
                  workspace: next.workspace,
                }
              })
            }}
            onSave={async () => {}}
            disabled={saving}
            submitDisabled={saving}
            services={services}
            devices={devices}
            runtimeWork={runtimeWork}
            deviceControl={
              <StandInDeviceSelect
                value={settings.executionDeviceId}
                currentDeviceId={localDeviceId}
                devices={devices}
                disabled={saving || dirty}
                onChange={onSelectDevice}
              />
            }
          />
          <p className="text-xs text-text-muted">{t('standIn.workspace.execution_device_help')}</p>
          {runtimeError && (
            <div role="alert" className="text-sm text-error">
              <p>{runtimeError}</p>
              <button
                type="button"
                data-testid="stand-in-primary-environment-retry"
                className="min-h-8 underline"
                onClick={() => setReload(value => value + 1)}
              >
                {t('standIn.reload')}
              </button>
            </div>
          )}
        </section>
      )}
      <ConfirmDialog
        open={discard}
        destructive
        title={t('standIn.personal.discard_help')}
        description={t('standIn.personal.discard_description')}
        cancelLabel={t('standIn.personal.keep_editing')}
        confirmLabel={t('standIn.personal.discard')}
        confirmTestId="stand-in-primary-discard"
        cancelTestId="stand-in-primary-keep-editing"
        onClose={() => {
          navigation.cancelLeave()
          setDiscard(false)
        }}
        onConfirm={() => {
          setDiscard(false)
          navigation.confirmLeave(onClose)
        }}
      />
      {!connections && management}
      {!scheduleDirty && (
        <StandInSettingsActions
          prefix="stand-in-primary"
          leading={footerLeading}
          disabled={saving}
          saveDisabled={saving || !dirty || scheduleDirty}
          onCancel={close}
          onSave={() => void onSave({ ...settings, primary: draft })}
        >
          {error && (
            <div role="alert" className="w-full text-sm text-destructive">
              <p>{error}</p>
              {onReload && (
                <button
                  type="button"
                  data-testid="stand-in-primary-settings-retry"
                  disabled={saving}
                  onClick={onReload}
                  className="min-h-8 underline"
                >
                  {t('standIn.reload')}
                </button>
              )}
            </div>
          )}
        </StandInSettingsActions>
      )}
    </div>
  )
}
