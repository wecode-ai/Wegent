import type { PersonalStandInSettings } from '@/api/personalStandIn'
import { connectionChangeEnablesIdentity, newStandInRole } from '@/api/personalStandIn'
import type { StandInExecutorApi } from '@/api/standIn'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import type { DeviceInfo } from '@/types/api'
import type { CollaborationProject } from '@wegent/collaboration'
import { createTagDraft } from '@wegent/collaboration'
import { DialogSurface } from '@wegent/collaboration/controls/DialogSurface'
import { Textarea as ControlTextarea } from '@wegent/collaboration/controls/Textarea'
import { dequal } from 'dequal'
import type { ReactNode, Ref } from 'react'
import { useCallback, useImperativeHandle, useRef, useState, useSyncExternalStore } from 'react'
import { StandInComposer } from './StandInComposer'
import type { StandInConnectionNavigationHandle } from './StandInConnectionSettings'
import { StandInConnectionSettings } from './StandInConnectionSettings'
import { StandInDeviceSelect } from './StandInDeviceSelect'
import {
  StandInSettingsActions,
  StandInSettingsEntry,
  StandInSettingsError,
  StandInSettingsHeader,
} from './StandInSettingsLayout'
import type { StandInSettingsHandle } from './StandInSettingsPage'
import { useStandInPanelNavigation } from './useStandInPanelNavigation'
import { useStandInRuntimeWork } from './useStandInRuntimeWork'

/** Edit the primary identity and its connections on the explicitly selected Executor. */
export function StandInPrimaryProfile({
  settings,
  saving,
  loading = false,
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
  deviceReadOnly = false,
  initialCalendar = false,
  onCalendarViewChange,
  onReload,
  management,
  footerLeading,
}: {
  settings: PersonalStandInSettings
  saving: boolean
  loading?: boolean
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
  deviceReadOnly?: boolean
  initialCalendar?: boolean
  onCalendarViewChange?(open: boolean): void
  onReload?(): void
  management?: ReactNode
  footerLeading?: ReactNode
}) {
  const { t } = useTranslation('common')
  const blocked = saving || loading
  const saved = settings.primary ?? { enabled: true, prompt: '', preferences: '' }
  const defaultRole = newStandInRole(settings.executionDeviceId, '@primary')
  const defaultCollaboration = {
    ...defaultRole.collaboration,
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
  const { runtimeWork, runtimeError, retryRuntimeWork } = useStandInRuntimeWork(
    services.runtimeWorkApi,
    settings.executionDeviceId
  )
  const [scheduleDirty, setScheduleDirty] = useState(false)
  const [tagOwner, setTagOwner] = useState(() => ({
    api,
    userId: settings.userId,
    deviceId: settings.executionDeviceId,
    store: createTagDraft(),
  }))
  if (
    tagOwner.api !== api ||
    tagOwner.userId !== settings.userId ||
    tagOwner.deviceId !== settings.executionDeviceId
  ) {
    setDraft(original)
    setBaseline(original)
    setTagOwner({
      api,
      userId: settings.userId,
      deviceId: settings.executionDeviceId,
      store: createTagDraft(),
    })
  }
  const tagDraft = tagOwner.store
  const connectionDraftDirty = useSyncExternalStore(
    tagDraft.subscribe,
    tagDraft.getDirtySnapshot,
    tagDraft.getDirtySnapshot
  )
  const dirty = !dequal(original, draft) || scheduleDirty || connectionDraftDirty

  const role = {
    ...defaultRole,
    ...draft,
  }
  const navigation = useStandInPanelNavigation(!dequal(original, draft), blocked, () =>
    setDiscard(true)
  )
  const connectionRef = useRef<StandInConnectionNavigationHandle>(null)
  const requestLeave = (action: () => void) => {
    if (connectionRef.current)
      connectionRef.current.requestLeave(discarded =>
        discarded ? action() : navigation.requestLeave(action)
      )
    else navigation.requestLeave(action)
  }
  const close = () => requestLeave(onClose)
  const dialogRef = useRef<HTMLDivElement>(null)
  useImperativeHandle(ref, () => ({ requestClose: close, requestLeave }))
  return (
    <DialogSurface
      onClose={close}
      suspended={discard}
      render={
        <div
          ref={dialogRef}
          className={`flex h-full min-h-0 flex-col px-5 ${calendarOpen ? 'overflow-hidden' : 'overflow-y-auto'}`}
          data-testid="stand-in-primary-profile"
        />
      }
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
        disabled={blocked}
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
              <ControlTextarea
                data-testid="stand-in-preferences"
                value={draft.preferences}
                disabled={blocked}
                onChange={event => setDraft({ ...draft, preferences: event.target.value })}
                placeholder={t('standIn.workspace.profile_instructions_placeholder')}
                rows={5}
                className="block w-full resize-y appearance-none rounded-lg border-0 bg-transparent p-3 text-sm outline-none placeholder:text-text-secondary"
              />
            </div>
            <span className="text-xs text-text-secondary">
              {t('standIn.workspace.profile_instructions_help')}
            </span>
          </label>
          <div className="mt-6">
            <StandInSettingsEntry
              label={t('standIn.workspace.connections')}
              description={t('standIn.workspace.connections_help')}
              testId="stand-in-primary-connections-open"
              disabled={blocked}
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
            projectScopeConfigured={Boolean(
              saved.collaboration || !dequal(draft.collaboration, original.collaboration)
            )}
            savedConfiguration={{
              connections: original.connections,
              collaboration: original.collaboration,
              calendar: original.calendar,
            }}
            scheduling={{ userId: settings.userId, roleId: '@primary' }}
            onScheduleDirtyChange={setScheduleDirty}
            tagDraft={tagDraft}
            projects={projects}
            api={api}
            deviceId={settings.executionDeviceId}
            localDeviceId={localDeviceId}
            disabled={blocked}
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
            <p className="mt-1 text-xs text-text-secondary">
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
            disabled={blocked}
            submitDisabled={blocked}
            services={services}
            devices={devices}
            runtimeWork={runtimeWork}
            deviceControl={
              <StandInDeviceSelect
                readOnly={deviceReadOnly}
                value={settings.executionDeviceId}
                currentDeviceId={localDeviceId}
                devices={devices}
                disabled={blocked || dirty}
                onChange={onSelectDevice}
              />
            }
          />
          <p className="text-xs text-text-secondary">
            {t('standIn.workspace.execution_device_help')}
          </p>
          <StandInSettingsError
            error={runtimeError}
            retry={{ testId: 'stand-in-primary-environment-retry', onClick: retryRuntimeWork }}
          />
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
          busy={blocked}
          saveLabel={saving ? t('standIn.saving') : loading ? t('standIn.loading') : undefined}
          disabled={blocked}
          saveDisabled={blocked || !dirty || scheduleDirty || connectionDraftDirty}
          onCancel={close}
          onSave={() =>
            void onSave({
              ...settings,
              primary: {
                ...draft,
                collaboration:
                  saved.collaboration || !dequal(draft.collaboration, original.collaboration)
                    ? draft.collaboration
                    : undefined,
              },
            })
          }
        >
          {error && (
            <div className="w-full">
              <StandInSettingsError
                error={error}
                retry={
                  onReload
                    ? {
                        testId: 'stand-in-primary-settings-retry',
                        disabled: blocked,
                        onClick: onReload,
                      }
                    : undefined
                }
              />
            </div>
          )}
        </StandInSettingsActions>
      )}
    </DialogSurface>
  )
}
