import type { PersonalStandInSettings, StandInIdentity } from '@/api/personalStandIn'
import {
  connectionChangeEnablesIdentity,
  newStandInPrimaryRole,
  primaryWithConnectionMode,
} from '@/api/personalStandIn'
import type { StandInExecutorApi } from '@/api/standIn'
import type { MessageCenterSource } from '@/api/standInMessageCenter'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { useExperimentalFeaturesEnabled } from '@/features/experimental-features/useExperimentalFeaturesEnabled'
import { useStableEvent } from '@/features/workbench/useStableEvent'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import type { DeviceInfo } from '@/types/api'
import type { CollaborationProject } from '@wegent/collaboration'
import { createTagDraft } from '@wegent/collaboration'
import { Textarea as ControlTextarea } from '@wegent/collaboration/controls/Textarea'
import { dequal } from 'dequal'
import type { ReactNode, Ref } from 'react'
import { useCallback, useImperativeHandle, useRef, useState, useSyncExternalStore } from 'react'
import { StandInComposer } from './StandInComposer'
import type { StandInConnectionNavigationHandle } from './StandInConnectionSettings'
import { StandInConnectionSettings } from './StandInConnectionSettings'
import { StandInDeviceSelect } from './StandInDeviceSelect'
import { StandInSelfLearningSetting } from './StandInSelfLearningSetting'
import { StandInTaskPermissionSettings } from './StandInTaskPermissionSettings'
import {
  StandInSettingsActions,
  StandInSettingsEntry,
  StandInSettingsError,
  StandInSettingsHeader,
  StandInSettingsPanel,
  StandInSettingsShortcuts,
  type StandInSettingsShortcut,
} from './StandInSettingsLayout'
import type { StandInSettingsHandle } from './StandInSettingsPage'
import {
  connectionConfigurationChanges,
  hasConnectionDraft,
  rebaseConnectionDraft,
} from './standInConnectionSettingsModel'
import { useStandInPanelNavigation } from './useStandInPanelNavigation'
import { useStandInRuntimeWork } from './useStandInRuntimeWork'

type NormalizedPrimary = StandInIdentity & {
  collaboration: NonNullable<StandInIdentity['collaboration']>
  connections: NonNullable<StandInIdentity['connections']>
}

interface StandInPrimaryProfileProps {
  settings: PersonalStandInSettings
  executionDeviceId?: string
  saving: boolean
  loading?: boolean
  error: string | null
  onSave(
    settings: PersonalStandInSettings,
    stayOpen?: boolean
  ): Promise<PersonalStandInSettings | void>
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
  initialConnections?: boolean | MessageCenterSource
  onCalendarViewChange?(open: boolean): void
  onReload?(): void
  shortcuts?: StandInSettingsShortcut[]
  footerLeading?: ReactNode
}

/** Edit the primary identity and its connections on the explicitly selected Executor. */
export function StandInPrimaryProfile(props: StandInPrimaryProfileProps) {
  return (
    <StandInPrimaryProfileEditor
      key={JSON.stringify([props.settings.userId, props.settings.executionDeviceId])}
      {...props}
    />
  )
}

function StandInPrimaryProfileEditor({
  settings: incomingSettings,
  executionDeviceId = incomingSettings.executionDeviceId,
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
  initialConnections = false,
  onCalendarViewChange,
  onReload,
  shortcuts,
  footerLeading,
}: StandInPrimaryProfileProps) {
  const { t } = useTranslation('common')
  const initialSource =
    initialConnections && typeof initialConnections === 'object' ? initialConnections : undefined
  const experimental = useExperimentalFeaturesEnabled()
  const blocked = saving || loading
  const settings = incomingSettings
  const saved = settings.primary ?? { enabled: true, prompt: '', preferences: '' }
  const defaultRole = newStandInPrimaryRole(executionDeviceId)
  const defaultCollaboration = defaultRole.collaboration
  const usesSeparatePrompt = (primary: StandInIdentity) =>
    settings.cloudDefinitionRevision !== undefined || primary.selfLearningEnabled !== undefined
  const separatePrompt = usesSeparatePrompt(saved)
  const normalizePrimary = (primary: StandInIdentity): NormalizedPrimary => {
    const separatePrompt = usesSeparatePrompt(primary)
    return {
      ...primary,
      delegation: primary.delegation,
      dingTalkConnectionMode: primary.dingTalkConnectionMode,
      collaboration: primary.collaboration ?? defaultCollaboration,
      calendar: primary.calendar,
      connections: primary.connections ?? [],
      prompt: separatePrompt ? primary.prompt : '',
      preferences: separatePrompt
        ? primary.preferences
        : [primary.prompt, primary.preferences].filter(Boolean).join('\n\n'),
    }
  }
  const original = normalizePrimary(saved)
  const [draft, setDraft] = useState(original)
  const [baseline, setBaseline] = useState(original)
  if (!dequal(baseline, original)) {
    setBaseline(original)
    if (dequal(draft, baseline)) setDraft(original)
  }
  const [view, setView] = useState<
    'main' | 'connections' | 'advanced' | StandInSettingsShortcut['id']
  >(initialCalendar || initialConnections ? 'connections' : 'main')
  if (view === 'revision' && !experimental) setView('main')
  const connections = view === 'connections'
  const shortcutPage = shortcuts?.find(shortcut => shortcut.id === view && !shortcut.onClick)
  const [calendarEntry, setCalendarEntry] = useState(initialCalendar)
  const [calendarOpen, setCalendarOpen] = useState(initialCalendar)
  const [connectionDetailOpen, setConnectionDetailOpen] = useState(initialCalendar)
  const [connectionTitle, setConnectionTitle] = useState<string | null>(null)
  const [connectionView, setConnectionView] = useState<string | null>(null)
  const [connectionScopeTitle, setConnectionScopeTitle] = useState<string | null>(null)
  const connectionTitleChanged = useCallback(
    (title: string | null, view: string | null, scopeTitle: string | null) => {
      setConnectionTitle(title)
      setConnectionView(view)
      setConnectionScopeTitle(scopeTitle)
    },
    []
  )
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
    executionDeviceId,
    view === 'advanced'
  )
  const [scheduleDirty, setScheduleDirty] = useState(false)
  const [scheduleEditorOpen, setScheduleEditorOpen] = useState(false)
  const [tagOwner, setTagOwner] = useState(() => ({
    api,
    store: createTagDraft(),
  }))
  if (tagOwner.api !== api) {
    setDraft(original)
    setBaseline(original)
    setTagOwner({
      api,
      store: createTagDraft(),
    })
  }
  const tagDraft = tagOwner.store
  const connectionDraftDirty = useSyncExternalStore(
    tagDraft.subscribe,
    tagDraft.getDirtySnapshot,
    tagDraft.getDirtySnapshot
  )
  const scopeView = connections && connectionScopeTitle ? connectionView : null
  const profileDirty = !dequal(original, draft)
  const dirty = profileDirty || scheduleDirty || connectionDraftDirty
  const preserveLegacyInstructions =
    !separatePrompt &&
    draft.selfLearningEnabled === true &&
    draft.preferences === original.preferences
  const savePrimary = async () => {
    const updated = scopeView
      ? { ...saved, ...connectionConfigurationChanges(saved, draft, scopeView) }
      : {
          ...draft,
          ...(preserveLegacyInstructions
            ? { prompt: saved.prompt, preferences: saved.preferences }
            : {}),
          collaboration:
            saved.collaboration || !dequal(draft.collaboration, original.collaboration)
              ? draft.collaboration
              : undefined,
        }
    const primary = scopeView
      ? primaryWithConnectionMode(saved, {
          ...updated,
          enabled: saved.enabled || connectionChangeEnablesIdentity(saved, updated),
        })
      : updated
    const result = await onSave({ ...settings, primary }, Boolean(scopeView))
    if (result?.primary && scopeView) {
      const accepted = normalizePrimary(result.primary)
      const remaining = {
        ...rebaseConnectionDraft(draft, original, accepted, scopeView),
        dingTalkConnectionMode: accepted.dingTalkConnectionMode,
      }
      setBaseline(accepted)
      setDraft({
        ...remaining,
        enabled: accepted.enabled || connectionChangeEnablesIdentity(accepted, remaining),
      })
      connectionRef.current?.returnToScopeList()
    }
  }
  const role = {
    ...defaultRole,
    ...draft,
  }
  const navigation = useStandInPanelNavigation(profileDirty, blocked, () => setDiscard(true))
  const requestProfileLeave = useStableEvent(navigation.requestLeave)
  const connectionRef = useRef<StandInConnectionNavigationHandle>(null)
  const requestLeave = (action: () => void) => {
    if (connectionRef.current) connectionRef.current.requestLeave(() => requestProfileLeave(action))
    else requestProfileLeave(action)
  }
  const reload = useStableEvent(() => {
    setDraft(original)
    onReload?.()
  })
  const close = () => requestLeave(onClose)
  const backToSettings = () => {
    const back = () => {
      setCalendarEntry(false)
      setView('main')
    }
    if (connectionRef.current) connectionRef.current.requestLeave(back)
    else back()
  }
  const back = () => {
    if (connections && connectionDetailOpen) connectionRef.current?.back()
    else backToSettings()
  }
  useImperativeHandle(ref, () => ({ requestClose: close, requestLeave }))
  return (
    <StandInSettingsPanel
      testId="stand-in-primary-profile"
      onClose={view === 'main' ? close : back}
      suspended={discard}
      calendarOpen={calendarOpen}
    >
      <StandInSettingsHeader
        path={[
          {
            label: t('standIn.workspace.primary_profile'),
            testId: 'stand-in-path-settings',
            onClick: view === 'main' || connections ? undefined : backToSettings,
          },
          ...(connections
            ? [
                {
                  label: t('standIn.workspace.connections'),
                  testId: 'stand-in-path-connections',
                },
              ]
            : view === 'advanced'
              ? [
                  {
                    label: t('standIn.workspace.execution_settings'),
                    testId: 'stand-in-path-advanced',
                  },
                ]
              : shortcutPage
                ? [{ label: shortcutPage.label, testId: 'stand-in-path-tool' }]
                : []),
          ...(connections && connectionTitle
            ? [{ label: connectionTitle, testId: 'stand-in-path-source' }]
            : []),
          ...(connections && connectionScopeTitle
            ? [{ label: connectionScopeTitle, testId: 'stand-in-path-scope' }]
            : []),
        ]}
        title={t(
          connections ? 'standIn.workspace.connections' : 'standIn.workspace.primary_profile'
        )}
        disabled={blocked}
        back={
          view === 'main'
            ? { testId: 'stand-in-primary-back', onClick: close }
            : {
                testId:
                  connections && connectionDetailOpen
                    ? 'stand-in-connections-back'
                    : 'stand-in-primary-back-to-settings',
                onClick: back,
              }
        }
        close={{ testId: 'stand-in-primary-profile-close', onClick: close }}
      />
      {view === 'main' && (
        <>
          {separatePrompt && (
            <label className="mb-4 grid gap-2">
              <span>{t('standIn.workspace.ghost_prompt')}</span>
              <ControlTextarea
                data-testid="stand-in-primary-ghost-prompt"
                value={draft.prompt}
                disabled={blocked}
                onChange={event => setDraft({ ...draft, prompt: event.target.value })}
                rows={4}
              />
            </label>
          )}
          <label className="grid gap-2">
            <span>
              {t(
                separatePrompt
                  ? 'standIn.workspace.ghost_private_preferences'
                  : 'standIn.workspace.profile_instructions'
              )}
            </span>
            <ControlTextarea
              data-testid="stand-in-preferences"
              value={draft.preferences}
              disabled={blocked}
              onChange={event => setDraft({ ...draft, preferences: event.target.value })}
              placeholder={t(
                separatePrompt
                  ? 'standIn.workspace.ghost_private_preferences_placeholder'
                  : 'standIn.workspace.profile_instructions_placeholder'
              )}
              rows={5}
              className="block resize-y"
            />
            <span className="text-xs text-text-secondary">
              {t(
                separatePrompt
                  ? 'standIn.workspace.ghost_private_preferences_help'
                  : 'standIn.workspace.profile_instructions_help'
              )}
            </span>
          </label>
          <div className="mt-6">
            <StandInSettingsEntry
              label={t('standIn.workspace.connections')}
              description={t('standIn.workspace.connections_help')}
              testId="stand-in-primary-connections-open"
              disabled={blocked}
              onClick={() => setView('connections')}
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
            onDetailTitleChange={connectionTitleChanged}
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
            initialSource={initialSource}
            onScheduleDirtyChange={setScheduleDirty}
            onScheduleEditorOpenChange={setScheduleEditorOpen}
            tagDraft={tagDraft}
            projects={projects}
            api={api}
            deviceId={settings.executionDeviceId}
            localDeviceId={localDeviceId}
            disabled={blocked}
            onChange={value =>
              setDraft(current => {
                const changed = hasConnectionDraft(value, original)
                const source = changed ? value : original
                return primaryWithConnectionMode(saved, {
                  ...current,
                  dingTalkConnectionMode: original.dingTalkConnectionMode,
                  enabled:
                    original.enabled ||
                    (changed && connectionChangeEnablesIdentity(original, value)),
                  collaboration: source.collaboration,
                  calendar: source.calendar,
                  connections: source.connections ?? [],
                })
              })
            }
          />
        </div>
      )}
      {view === 'main' && (
        <div className="mt-4" data-testid="stand-in-primary-execution">
          <StandInSettingsEntry
            testId="stand-in-primary-execution-toggle"
            label={t('standIn.workspace.execution_settings')}
            description={t('standIn.workspace.execution_settings_help')}
            disabled={blocked}
            onClick={() => setView('advanced')}
          />
        </div>
      )}
      {view === 'advanced' && (
        <div data-testid="stand-in-primary-execution" className="space-y-3">
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
                value={executionDeviceId}
                testId="personal-assistant-execution-device"
                currentDeviceId={localDeviceId}
                devices={devices}
                disabled={blocked || dirty}
                onChange={onSelectDevice}
              />
            }
          />
          <StandInTaskPermissionSettings
            value={draft.taskPermissions}
            disabled={blocked}
            onChange={taskPermissions => setDraft(current => ({ ...current, taskPermissions }))}
          />
          <p className="text-xs text-text-secondary">
            {t('standIn.workspace.execution_device_help')}
          </p>
          <StandInSettingsError
            error={runtimeError}
            retry={{ testId: 'stand-in-primary-environment-retry', onClick: retryRuntimeWork }}
          />
        </div>
      )}
      {shortcutPage?.content}
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
      {view === 'main' && (
        <StandInSettingsShortcuts shortcuts={shortcuts} disabled={blocked} onOpen={setView} />
      )}
      {view === 'main' && experimental && (
        <StandInSelfLearningSetting
          enabled={draft.selfLearningEnabled}
          disabled={blocked}
          onChange={selfLearningEnabled =>
            setDraft(current => ({ ...current, selfLearningEnabled }))
          }
          report={shortcuts?.find(shortcut => shortcut.id === 'revision')}
          onOpenReport={() => setView('revision')}
        />
      )}
      {!scheduleDirty && !scheduleEditorOpen && !shortcutPage && (
        <StandInSettingsActions
          prefix="stand-in-primary"
          leading={connectionDetailOpen ? undefined : footerLeading}
          busy={blocked}
          saveLabel={
            saving
              ? t('standIn.saving')
              : loading
                ? t('standIn.loading')
                : scopeView
                  ? t('standIn.personal.save_receive_scope')
                  : undefined
          }
          disabled={blocked}
          saveDisabled={
            blocked ||
            scheduleDirty ||
            connectionDraftDirty ||
            !(scopeView ? hasConnectionDraft(draft, original, scopeView) : profileDirty)
          }
          cancelLabel={scopeView ? t('standIn.personal.discard') : undefined}
          onCancel={scopeView ? back : close}
          onSave={() => {
            void savePrimary()
          }}
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
                        onClick: () => requestLeave(reload),
                      }
                    : undefined
                }
              />
            </div>
          )}
        </StandInSettingsActions>
      )}
    </StandInSettingsPanel>
  )
}
