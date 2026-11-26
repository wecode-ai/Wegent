import type { PersonalStandInSettings, StandInIdentity } from '@/api/personalStandIn'
import { connectionChangeEnablesIdentity, newStandInRole } from '@/api/personalStandIn'
import type { StandInExecutorApi } from '@/api/standIn'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import {
  defaultDingTalkDelegation,
  dingTalkDelegationModel,
  isDingTalkSource,
} from '@/features/collaboration-exp/stand-in/dingtalkDelegation'
import { useExperimentalFeaturesEnabled } from '@/features/experimental-features/useExperimentalFeaturesEnabled'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import type { DeviceInfo } from '@/types/api'
import type { CollaborationProject } from '@wegent/collaboration'
import { createTagDraft } from '@wegent/collaboration'
import { Textarea as ControlTextarea } from '@wegent/collaboration/controls/Textarea'
import { dequal } from 'dequal'
import type { ReactNode, Ref } from 'react'
import { useCallback, useImperativeHandle, useRef, useState, useSyncExternalStore } from 'react'
import { StandInTeamBinding } from './StandInTeamBinding'
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
import { useStandInPanelNavigation } from './useStandInPanelNavigation'
import { useStandInRuntimeWork } from './useStandInRuntimeWork'

type NormalizedPrimary = StandInIdentity & {
  collaboration: NonNullable<StandInIdentity['collaboration']>
  connections: NonNullable<StandInIdentity['connections']>
}

const primaryDraftFields = [
  'enabled',
  'prompt',
  'preferences',
  'selfLearningEnabled',
  'workspace',
  'taskPermissions',
  'calendar',
  'collaboration',
] as const

function rebasePrimaryDraft(
  current: NormalizedPrimary,
  previous: NormalizedPrimary,
  saved: NormalizedPrimary
): NormalizedPrimary {
  const draft = { ...saved }
  const keepEdit = <Field extends keyof NormalizedPrimary>(field: Field) => {
    if (!dequal(current[field], previous[field])) draft[field] = current[field]
  }
  primaryDraftFields.forEach(keepEdit)
  if (dequal(previous.model, saved.model) && dequal(previous.modelOptions, saved.modelOptions)) {
    keepEdit('model')
    keepEdit('modelOptions')
  }
  const otherConnections = current.connections.filter(row => !isDingTalkSource(row))
  const previousOtherConnections = previous.connections.filter(row => !isDingTalkSource(row))
  const savedOtherConnections = saved.connections.filter(row => !isDingTalkSource(row))
  if (
    !dequal(otherConnections, previousOtherConnections) &&
    !dequal(otherConnections, savedOtherConnections)
  ) {
    draft.connections = [...otherConnections, ...saved.connections.filter(isDingTalkSource)]
  }
  return draft
}

/** Edit the primary identity and its connections on the explicitly selected Executor. */
export function StandInPrimaryProfile({
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
  onCalendarViewChange,
  onReload,
  shortcuts,
  footerLeading,
  dingtalkSourceProblem,
}: {
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
  onCalendarViewChange?(open: boolean): void
  onReload?(): void
  shortcuts?: StandInSettingsShortcut[]
  footerLeading?: ReactNode
  dingtalkSourceProblem?: string
}) {
  const { t } = useTranslation('common')
  const experimental = useExperimentalFeaturesEnabled()
  const blocked = saving || loading
  const [receipt, setReceipt] = useState<PersonalStandInSettings | null>(null)
  const settings =
    receipt?.userId === incomingSettings.userId &&
    receipt.executionDeviceId === incomingSettings.executionDeviceId &&
    receipt.version > incomingSettings.version
      ? receipt
      : incomingSettings
  if (receipt && settings === incomingSettings) setReceipt(null)
  const saved = settings.primary ?? { enabled: true, prompt: '', preferences: '' }
  const defaultRole = newStandInRole(executionDeviceId, '@primary')
  const defaultCollaboration = {
    ...defaultRole.collaboration,
    policy: { automatic: true, askBeforeAct: true, immediate: false },
  }
  const usesSeparatePrompt = (primary: StandInIdentity) =>
    settings.cloudDefinitionRevision !== undefined || primary.selfLearningEnabled !== undefined
  const separatePrompt = usesSeparatePrompt(saved)
  const normalizePrimary = (primary: StandInIdentity): NormalizedPrimary => {
    const separatePrompt = usesSeparatePrompt(primary)
    return {
      ...primary,
      delegation: primary.delegation,
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
  >(initialCalendar ? 'connections' : 'main')
  if (view === 'revision' && !experimental) setView('main')
  const connections = view === 'connections'
  const shortcutPage = shortcuts?.find(shortcut => shortcut.id === view && !shortcut.onClick)
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
    executionDeviceId,
    view === 'advanced'
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
    setReceipt(null)
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
  const profileDirty = !dequal(
    { ...original, delegation: original.delegation ?? defaultDingTalkDelegation },
    { ...draft, delegation: draft.delegation ?? defaultDingTalkDelegation }
  )
  const dirty = profileDirty || scheduleDirty || connectionDraftDirty
  const preserveLegacyInstructions =
    !separatePrompt &&
    draft.selfLearningEnabled === true &&
    draft.preferences === original.preferences
  const ordinarySubmission = dingTalkDelegationModel(original, draft).submission()
  const savePrimary = (submission: typeof ordinarySubmission) =>
    onSave({
      ...settings,
      primary: {
        ...submission,
        ...(preserveLegacyInstructions
          ? { prompt: saved.prompt, preferences: saved.preferences }
          : {}),
        collaboration:
          saved.collaboration || !dequal(draft.collaboration, original.collaboration)
            ? draft.collaboration
            : undefined,
      },
    })
  const saveDingTalk = async (value: StandInIdentity) => {
    const next = await onSave(
      {
        ...settings,
        primary: value,
      },
      true
    )
    const primary = next?.primary
    if (!primary) return false
    const accepted = normalizePrimary(primary)
    setReceipt(next)
    setDraft(current => rebasePrimaryDraft(current, original, accepted))
    return true
  }
  const role = {
    ...defaultRole,
    ...draft,
  }
  const navigation = useStandInPanelNavigation(profileDirty, blocked, () => setDiscard(true))
  const connectionRef = useRef<StandInConnectionNavigationHandle>(null)
  const requestLeave = (action: () => void) => {
    if (connectionRef.current)
      connectionRef.current.requestLeave(discarded =>
        discarded ? action() : navigation.requestLeave(action)
      )
    else navigation.requestLeave(action)
  }
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
            onClick: view === 'main' ? undefined : backToSettings,
          },
          ...(connections
            ? [
                {
                  label: t('standIn.workspace.connections'),
                  testId: 'stand-in-path-connections',
                  onClick: connectionDetailOpen ? () => connectionRef.current?.back() : undefined,
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
            dingTalk={{
              saved: settings.primary ?? { enabled: false, prompt: '', preferences: '' },
              services,
              devices,
              primaryStopped: Boolean(settings.lifecycle),
              sourceProblem: dingtalkSourceProblem,
              onSave: saveDingTalk,
            }}
            onChange={value =>
              setDraft({
                ...draft,
                enabled:
                  original.enabled ||
                  connectionChangeEnablesIdentity(
                    {
                      ...original,
                      connections: original.connections.filter(row => !isDingTalkSource(row)),
                    },
                    {
                      ...value,
                      connections: value.connections?.filter(row => !isDingTalkSource(row)),
                    }
                  ),
                collaboration: value.collaboration,
                calendar: value.calendar,
                connections: value.connections ?? [],
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
          {api && (
            <StandInTeamBinding
              api={api}
              userId={settings.userId}
              deviceId={executionDeviceId}
              value={draft.teamRef}
              disabled={blocked}
              onChange={teamRef => setDraft(current => ({ ...current, teamRef }))}
            />
          )}
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
      {!scheduleDirty && !shortcutPage && (
        <StandInSettingsActions
          prefix="stand-in-primary"
          leading={footerLeading}
          busy={blocked}
          saveLabel={saving ? t('standIn.saving') : loading ? t('standIn.loading') : undefined}
          disabled={blocked}
          saveDisabled={
            blocked ||
            !profileDirty ||
            scheduleDirty ||
            connectionDraftDirty ||
            dequal(original, ordinarySubmission)
          }
          onCancel={close}
          onSave={() => {
            const save = () => void savePrimary(ordinarySubmission)
            if (connectionRef.current) connectionRef.current.requestLeaveDingTalk(save)
            else save()
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
                        onClick: onReload,
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
