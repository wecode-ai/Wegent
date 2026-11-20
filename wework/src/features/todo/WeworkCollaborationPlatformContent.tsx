import { DialogSurface } from '@wegent/collaboration/controls/DialogSurface'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { useWindowEvent } from '@wegent/collaboration/dom-events'
import { GlobalTodoSearch } from './GlobalTodoSearch'
import { resolveIssueReference } from './resolveIssueReference'
import { Search } from 'lucide-react'
import { Tooltip } from '@/components/ui/tooltip'
import { createWeworkPlatformNavigation } from './weworkPlatformNavigation'
import { createWeworkProjectMigration } from './weworkProjectMigration'
import { createAsyncResource } from '@wegent/chat-core/async-resource'
import { DefaultRunnerSetting } from '@/components/settings/DefaultRunnerSetting'
import { DesktopProjectSettingsPages } from './DesktopProjectSettingsPages'
import { IndependentIssuesProvider } from './IndependentIssuesProvider'
import { createPersonalIssuesApi } from '@/api/personalIssues'
import { PersonalIssuesView } from './PersonalIssuesView'

import { ConfirmDialog } from '@/components/common/ConfirmDialog'

import { PersonalHomeTaskComposer } from './PersonalHomeTaskComposer'
import { issueRuntimePort } from './issueRuntimePort'

import { useStandInProjects } from './useStandInProjects'
import { StandInIcon } from '@wegent/collaboration'
import { bindProjectStandInApi } from '@/api/standIn'
import { WeworkPersonalHome, type PersonalHomeIssueDetailContext } from './WeworkPersonalHome'
import { PersonalStandInWorkspace } from './PersonalStandInWorkspace'

import { LOCAL_USER } from '@/api/local/localSession'
import { WorkspaceRunnerRegistrationDialog } from '@/features/collaboration/WorkspaceRunnerRegistrationDialog'

import { navigateTo } from '@/lib/navigation'
import { createLocalWorkspaceApi, LOCAL_WORKSPACE_ID } from './localWorkspaceApi'
import { createWeworkPlatformApi, withoutDefaultWorkItemProject } from './weworkPlatformApi'
import {
  CollaborationTemplateStore,
  browserTemplatePersistence,
  createCollaborationTemplateRemote,
} from '@wegent/collaboration/templates'
import { createHttpClient } from '@/api/http'
import { getRuntimeConfig } from '@/config/runtime'
import {
  useCallback,
  useMemo,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type SetStateAction,
} from 'react'
import {
  CollaborationPlatformApp,
  type CollaborationPlatformLocation,
  type CollaborationProject,
  type SharedWorkspaceApi,
} from '@wegent/collaboration'

import { DEFAULT_WORK_ITEM_PROJECT_ID } from '@/api/deliveries'

import { useTranslation } from '@/hooks/useTranslation'

import { AddCloudDeviceDialog } from '@/components/settings/AddCloudDeviceDialog'

import { resolveDeviceResourceSettingsOptions } from './deviceResourceSettings'

import { normalizeClipboardImageFiles } from '@/lib/clipboard-images'

import { DesktopSidebarAccount } from '@/components/layout/DesktopSidebarAccount'
import { createWeworkProjectAgentConfigurationHost } from '@/features/collaboration/WeworkProjectAgentConfigurationHost'
import { generateCollaborationGroupDraft } from '@/features/collaboration/collaborationGroupDraftGeneration'

import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'

import { getNewChatModelSelection } from '@/features/workbench/workbenchProviderHelpers'
import {
  defaultNewChatModelSelection,
  modelSelectionIdentityOptions,
} from '@/features/workbench/runtimeModelSelection'
import { getDefaultModelOptions, getModelDisplayLabel } from '@/lib/model-ui'
import { runtimeProjectUiId } from '@/lib/runtime-project'

import { WeworkCollaborationEmbeddedBrowserHost } from './WeworkCollaborationEmbeddedBrowserHost'

import { WeworkIssueHomeComposer } from './WeworkIssueHomeComposer'
import { CloudConnectionDialog } from '@/features/cloud-connection/CloudConnectionDialog'
import {
  routeProjectLocation,
  normalizeWorkspaceRoot,
  projectWorkspaceRoots,
} from './weworkCollaborationRuntime'
import type { WeworkCollaborationPlatformProps } from './weworkCollaborationTypes'
import { WeworkSharedProject } from './WeworkSharedProject'
import { useCollaborationProjectPins } from './useCollaborationProjectPins'
export function WeworkCollaborationPlatformContent(props: WeworkCollaborationPlatformProps) {
  const { i18n, t } = useTranslation('common')
  const loadProjectCollaborationGroupGenerationModels = useCallback(async () => {
    const response = await props.services.modelApi.listModels()
    const models = response.data.filter(
      model => model.isActive !== false && !model.compatibilityDisabled
    )
    const defaultSelection =
      getNewChatModelSelection(props.user) ?? defaultNewChatModelSelection(models)
    return {
      models: models.map(model => ({
        modelName: model.name,
        modelType: model.type,
        displayName: getModelDisplayLabel(model),
        options: {
          ...getDefaultModelOptions(model),
          ...modelSelectionIdentityOptions(model),
        },
      })),
      defaultSelection,
    }
  }, [props.services.modelApi, props.user])
  const [issueSearchOpen, setIssueSearchOpen] = useState(false)
  const [issueSearchQuery, setIssueSearchQuery] = useState('')
  useWindowEvent(
    'keydown',
    event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setIssueSearchOpen(true)
      } else if (event.key === 'Escape') setIssueSearchOpen(false)
    },
    { enabled: props.workspaceActive !== false }
  )
  const standInProjects = useStandInProjects(props.services, props.devices, Number(props.user.id))
  const cloudConnection = useOptionalCloudConnection()
  const templateOwnerId =
    cloudConnection.user?.id && cloudConnection.user.id > 0
      ? cloudConnection.user.id
      : Number(props.user.id)
  const templateBackend = cloudConnection.apiBaseUrl ?? getRuntimeConfig().apiBaseUrl
  const [independentSelection, setIndependentSelection] = useState<{
    scope: string
    selection: string | null | undefined
  }>({ scope: '', selection: undefined })
  const personalIssuesApi = useMemo(
    () =>
      cloudConnection.isConnected
        ? createPersonalIssuesApi(
            createHttpClient({
              baseUrl: templateBackend,
              getToken: () => cloudConnection.token,
              redirectOnUnauthorized: false,
            })
          )
        : null,
    [cloudConnection.isConnected, cloudConnection.token, templateBackend]
  )
  const templateScope = `${templateBackend}:${cloudConnection.user?.id ? 'account' : 'local'}:${templateOwnerId}`
  const projectPins = useCollaborationProjectPins(templateScope)
  const independentIssueSelection =
    independentSelection.scope === templateScope ? independentSelection.selection : undefined
  const setIndependentIssueSelection = (selection: string | null | undefined) =>
    setIndependentSelection({ scope: templateScope, selection })
  const templateStore = useMemo(
    () =>
      new CollaborationTemplateStore({
        scope: templateScope,
        ownerId: templateOwnerId,
        persistence: browserTemplatePersistence(templateScope, localStorage),
        remote: cloudConnection.isConnected
          ? createCollaborationTemplateRemote(
              createHttpClient({
                baseUrl: templateBackend,
                getToken: () => cloudConnection.token,
                redirectOnUnauthorized: false,
              })
            )
          : undefined,
      }),
    [
      templateBackend,
      templateOwnerId,
      templateScope,
      cloudConnection.isConnected,
      cloudConnection.token,
    ]
  )
  const [cloudLoginIntent, setCloudLoginIntent] = useState<
    'general' | 'issue' | 'resume-issue' | null
  >(null)
  if (cloudLoginIntent === 'resume-issue' && personalIssuesApi) {
    setIndependentSelection({ scope: templateScope, selection: null })
    setCloudLoginIntent(null)
  }
  const [migration] = useState(createWeworkProjectMigration)
  const [conversationRequest, setConversationRequest] = useState<{
    projectId: string
    projectStore: CollaborationProject['project_store']
    accountScope: string
    key: string
  }>()
  const openProjectConversation = useCallback(
    (project: CollaborationProject) => {
      setConversationRequest({
        projectId: project.id,
        projectStore: project.project_store,
        accountScope: templateScope,
        key: crypto.randomUUID(),
      })
    },
    [templateScope]
  )
  const api = props.services.sharedWorkspaceApi
  const locale = useMemo(() => (i18n.language.startsWith('zh') ? 'zh-CN' : 'en'), [i18n.language])
  const collaborationUserName =
    props.user.user_name.trim().toLowerCase() === 'local'
      ? locale === 'zh-CN'
        ? '我'
        : 'Me'
      : props.user.user_name
  const personalOwnerLabel = locale === 'zh-CN' ? '个人' : 'Personal'
  const ownerGroupsResource = useMemo(
    () =>
      createAsyncResource(templateScope, async () => {
        const groups = (await props.services.agentResourceApi?.listOwnerGroups?.()) ?? []
        return groups.map(group => ({ label: group.displayName, namespace: group.name }))
      }),
    [templateScope, props.services.agentResourceApi]
  )
  const ownerGroupsSnapshot = useSyncExternalStore(
    ownerGroupsResource.subscribe,
    ownerGroupsResource.getSnapshot,
    ownerGroupsResource.getSnapshot
  )
  const workspaceOwnerOptions = useMemo(
    () => [
      { label: personalOwnerLabel, namespace: 'default' },
      ...(ownerGroupsSnapshot.data ?? []),
    ],
    [ownerGroupsSnapshot.data, personalOwnerLabel]
  )
  const projectAgentConfiguration = useMemo(
    () =>
      createWeworkProjectAgentConfigurationHost(
        props.services.agentResourceApi,
        props.services.localProjectChatAgentApi,
        props.services.projectSpaceDetailServices?.local?.modelApi,
        props.services.pluginApi,
        props.services.deviceApi
      ),
    [
      props.services.agentResourceApi,
      props.services.deviceApi,
      props.services.projectSpaceDetailServices?.local?.modelApi,
      props.services.pluginApi,
      props.services.localProjectChatAgentApi,
    ]
  )
  const localProjectApi = useMemo(
    () =>
      createLocalWorkspaceApi(
        props.services.projectSpaceApis?.local,
        Number(props.user.id),
        collaborationUserName,
        props.user.email ?? null,
        props.services.projectSpaceDetailServices?.local,
        locale
      ),
    [
      props.services.projectSpaceApis?.local,
      props.services.projectSpaceDetailServices?.local,
      props.user.email,
      props.user.id,
      collaborationUserName,
      locale,
    ]
  )
  const personalHomeTaskDrafts = props.homeDraft.personalHomeTaskDraftStore.get(templateScope, [
    api,
    props.services.projectSpaceApis?.local,
  ])
  const activeProject =
    String(props.activeProjectRef?.projectId) === DEFAULT_WORK_ITEM_PROJECT_ID
      ? null
      : (props.activeProjectRef ?? null)
  const [navigationOwner, setNavigationOwner] = useState(() => ({
    scope: templateScope,
    source: createWeworkPlatformNavigation({
      api: null,
      activeProject,
      focusedItemId: props.focusedItemId,
      focusedCommentId: props.focusedCommentId,
      focusedCommentRequestKey: props.focusedCommentRequestKey,
      onActiveProjectChange: props.onActiveProjectChange,
      startupActive: props.startupActive,
    }),
  }))
  let currentNavigation = navigationOwner
  if (navigationOwner.scope !== templateScope) {
    currentNavigation = {
      scope: templateScope,
      source: createWeworkPlatformNavigation({
        api: null,
        activeProject,
        focusedItemId: props.focusedItemId,
        focusedCommentId: props.focusedCommentId,
        focusedCommentRequestKey: props.focusedCommentRequestKey,
        onActiveProjectChange: props.onActiveProjectChange,
        startupActive: props.startupActive,
      }),
    }
    setNavigationOwner(currentNavigation)
  }
  const navigation = currentNavigation.source
  const platformApi = useMemo(() => {
    const platform = createWeworkPlatformApi(api, localProjectApi, navigation.getProjectStore)
    if (!platform || !props.services.standInApi || !props.services.getLocalRuntimeSidebarIdentity)
      return platform
    const standIn = async (projectId: string) => {
      const project = await platform.projects.get(projectId)
      return bindProjectStandInApi(
        props.services.standInApi!,
        Number(props.user.id),
        project.project_store === 'local' ? 'local' : 'cloud',
        props.services.getLocalRuntimeSidebarIdentity!
      )
    }
    return {
      ...platform,
      standIn: {
        get: async (projectId: string, deviceId?: string, id?: string) =>
          (await standIn(projectId)).get(projectId, deviceId, id),
        save: async (
          projectId: string,
          settings: import('@wegent/collaboration').WorkspaceStandInSettings,
          deviceId?: string
        ) => (await standIn(projectId)).save(projectId, settings, deviceId),
        run: async (projectId: string, issueId: string, deviceId: string, id?: string) =>
          (await standIn(projectId)).run!(projectId, issueId, deviceId, id),
      },
    }
  }, [api, localProjectApi, navigation, props.services, props.user.id])
  const navigationApis = useMemo(
    () =>
      [
        localProjectApi,
        cloudConnection.isConnected && api?.workspaces
          ? withoutDefaultWorkItemProject(api)
          : undefined,
      ].filter((candidate): candidate is SharedWorkspaceApi => Boolean(candidate)),
    [api, cloudConnection.isConnected, localProjectApi]
  )
  const navigationInput = useMemo(
    () => ({
      api: platformApi,
      activeProject,
      focusedItemId: props.focusedItemId,
      focusedCommentId: props.focusedCommentId,
      focusedCommentRequestKey: props.focusedCommentRequestKey,
      onActiveProjectChange: props.onActiveProjectChange,
      startupActive: props.startupActive,
    }),
    [
      platformApi,
      activeProject,
      props.focusedItemId,
      props.focusedCommentId,
      props.focusedCommentRequestKey,
      props.onActiveProjectChange,
      props.startupActive,
    ]
  )
  const subscribeNavigation = useCallback(
    (listener: () => void) => navigation.subscribe(listener, navigationInput),
    [navigation, navigationInput]
  )
  const { location, personalHomeEntryKey } = useSyncExternalStore(
    subscribeNavigation,
    navigation.getSnapshot,
    navigation.getSnapshot
  )
  const setLocation: Dispatch<SetStateAction<CollaborationPlatformLocation>> = next =>
    navigation.updateLocation(
      typeof next === 'function' ? next(navigation.getSnapshot().location) : next
    )
  const navigatePlatform = navigation.navigate
  const handleReady = navigation.handleReady
  const migrationInput = useMemo(
    () => ({
      scope: templateScope,
      backend: templateBackend,
      token: cloudConnection.token,
      userId: Number(cloudConnection.user?.id ?? props.user.id),
      cloudUserId: cloudConnection.user?.id,
      localApi: localProjectApi,
      cloudApi: api,
      services: props.services,
      onMigrated: (project: CollaborationProject) =>
        navigation.navigate(
          routeProjectLocation({ projectStore: 'backend', projectId: project.id }, null)!
        ),
      t,
    }),
    [
      templateScope,
      templateBackend,
      cloudConnection.token,
      cloudConnection.user?.id,
      props.user.id,
      localProjectApi,
      api,
      props.services,
      navigation,
      t,
    ]
  )
  const subscribeMigration = useCallback(
    (listener: () => void) => migration.subscribe(listener, migrationInput),
    [migration, migrationInput]
  )
  const {
    project: migrationProject,
    pending: migrationPending,
    error: migrationError,
    stage: migrationStage,
    revision: migrationRevision,
  } = useSyncExternalStore(subscribeMigration, migration.getSnapshot, migration.getSnapshot)
  if (!platformApi) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-text-muted">
        协作服务当前不可用
      </div>
    )
  }

  const renderPersonalIssueDetail = (context: PersonalHomeIssueDetailContext) => {
    const projectApi = context.project.project_store === 'local' ? localProjectApi : api
    if (!projectApi) return null
    return (
      <WeworkSharedProject
        api={projectApi}
        project={context.project}
        personalIssue={{
          ...context,
          onOpenInProject: () => {
            navigation.openKnownProject(context.project, context.issue.id)
          },
        }}
        projectCatalogApi={platformApi.projects}
        detailServices={
          props.services.projectSpaceDetailServices?.[
            context.project.project_store === 'local' ? 'local' : 'cloud'
          ]
        }
        devices={props.devices}
        localProjects={props.localProjects}
        locale={locale}
        location={location}
        setLocation={setLocation}
        userId={props.user.id}
        services={props.services}
        workspace={{
          id: context.project.workspace_id ?? '',
          public_id: '',
          location: 'cloud',
          name: context.project.name,
        }}
        runtimePort={issueRuntimePort(context.project.project_store, props.services)}
        runtimeWork={props.runtimeWork}
        runtimeTaskLifecycle={props.runtimeTaskLifecycle}
        onOpenRuntimeTask={props.onOpenRuntimeTask}
        onOpenSettings={props.onOpenSettings}
      />
    )
  }

  return (
    <div className="h-full min-h-0 flex-1" data-testid="wework-collaboration-platform">
      {issueSearchOpen && props.workspaceActive !== false && (
        <GlobalTodoSearch
          key={`issue-reference-search:${templateScope}`}
          referenceOnly
          projects={[]}
          projectItems={{}}
          projectMembers={{}}
          query={issueSearchQuery}
          onQueryChange={setIssueSearchQuery}
          onClose={() => setIssueSearchOpen(false)}
          onSelectProject={() => {}}
          onResolveReference={reference =>
            resolveIssueReference(reference, [
              ...(localProjectApi ? [{ location: 'local' as const, api: localProjectApi }] : []),
              ...(cloudConnection.isConnected && api ? [{ location: 'cloud' as const, api }] : []),
            ])
          }
          onSelectItem={(project, item) => {
            if (item.can_view_detail === false) return
            const next = routeProjectLocation(
              { projectStore: project.project_store, projectId: String(project.id) },
              item.id
            )
            if (next) {
              navigatePlatform(next, project)
              setIssueSearchOpen(false)
            }
          }}
        />
      )}
      <ConfirmDialog
        open={Boolean(migrationProject && cloudConnection.isConnected)}
        title={t('localProjectMigration.title')}
        description={`${t('localProjectMigration.description', { name: migrationProject?.name, account: cloudConnection.user?.user_name ?? collaborationUserName })}${migrationPending ? `\n${t(`localProjectMigration.${migrationStage}`)}` : ''}${migrationError ? `\n${migrationError}` : ''}`}
        confirmLabel={t('localProjectMigration.confirm')}
        cancelLabel={t('cancel')}
        confirmTestId="local-project-migration-confirm"
        dialogTestId="local-project-migration-dialog"
        pending={migrationPending}
        onClose={migration.close}
        onConfirm={migration.confirm}
      />
      {cloudLoginIntent && cloudLoginIntent !== 'resume-issue' && (
        <CloudConnectionDialog
          open
          intent={cloudLoginIntent === 'issue' ? 'independent-issue' : undefined}
          onlineCloudDeviceCount={0}
          onClose={() => setCloudLoginIntent(null)}
          onConnected={() =>
            setCloudLoginIntent(current => (current === 'issue' ? 'resume-issue' : null))
          }
          onOpenSettings={() => {
            setCloudLoginIntent(null)
            props.onOpenSettings?.({ settingsPage: 'connections' })
          }}
        />
      )}
      <IndependentIssuesProvider
        key={templateScope}
        api={personalIssuesApi}
        collaborationApi={api ?? undefined}
        userId={Number(cloudConnection.user?.id ?? props.user.id)}
        selection={independentIssueSelection}
        onSelect={setIndependentIssueSelection}
        onLogin={() => setCloudLoginIntent('issue')}
        onOpenProjectIssue={(projectId, issueId) => {
          const next = routeProjectLocation({ projectStore: 'backend', projectId }, issueId)
          if (next) navigatePlatform(next)
        }}
      >
        <CollaborationPlatformApp
          api={platformApi}
          refreshKey={`${Boolean(props.startupActive)}:${migrationRevision}`}
          navigationApis={navigationApis}
          locale={locale}
          onReady={handleReady}
          normalizePastedFiles={normalizeClipboardImageFiles}
          host={{
            settingsPages: DesktopProjectSettingsPages,
            convertLocalProjectToCloud: project => {
              migration.select(project)
              if (!cloudConnection.isConnected) setCloudLoginIntent('general')
            },
            accountScope: templateScope,
            issueHomeDraft: {
              getRevision: () =>
                props.homeDraft.getInputRevisionForScope(`collaboration-home:${templateScope}`),
              projectId:
                props.homeDraft.inputByScope[`collaboration-home-project:${templateScope}`] ?? null,
              onSelectProject: projectId =>
                props.homeDraft.setInputForScope(
                  `collaboration-home-project:${templateScope}`,
                  projectId
                ),
              value: props.homeDraft.inputByScope[`collaboration-home:${templateScope}`] ?? '',
              onChange: value =>
                props.homeDraft.setInputForScope(`collaboration-home:${templateScope}`, value),
            },
            templateStore,
            templateNavigation: true,
            createIndependentIssue: () =>
              personalIssuesApi ? setIndependentIssueSelection(null) : setCloudLoginIntent('issue'),
            renderIssueList: list => (
              <PersonalIssuesView
                key={list.scope}
                {...list}
                renderIssueDetail={renderPersonalIssueDetail}
                onOpenProject={project => {
                  const next = routeProjectLocation(
                    { projectStore: project.project_store, projectId: String(project.id) },
                    null
                  )
                  if (next) navigatePlatform(next)
                }}
                sources={navigationApis}
                userId={Number(props.user.id)}
                localUserIds={
                  props.services.localParticipationIdentity?.viewerUserIds ?? [LOCAL_USER.id]
                }
                active={props.workspaceActive ?? true}
              />
            ),
            renderPersonalHome: ({ contentVisible, ...home }) => (
              <WeworkPersonalHome
                key={templateScope}
                entryRequestKey={personalHomeEntryKey}
                userId={Number(props.user.id)}
                localUserIds={
                  props.services.localParticipationIdentity?.viewerUserIds ?? [LOCAL_USER.id]
                }
                active={(props.workspaceActive ?? true) && contentVisible}
                {...home}
                sources={navigationApis}
                draftScope={personalHomeTaskDrafts}
                renderIssueDetail={renderPersonalIssueDetail}
                conversation={(active, collaborationWork) => (
                  <PersonalStandInWorkspace
                    homeProjects={home.projects}
                    collaborationWork={collaborationWork}
                    services={props.services}
                    user={props.user}
                    devices={props.devices ?? []}
                    active={active}
                    contentRoute="/stand-in"
                    embedded
                    onClose={() => {}}
                    onOpenTask={props.onOpenRuntimeTask}
                  />
                )}
              />
            ),
            openProjectConversation,
            projectPins: {
              ...projectPins,
              heading: t('workbench.pinned'),
              pinLabel: t('workbench.pin_project'),
              unpinLabel: t('workbench.unpin_project'),
              saveError: t('workbench.collaboration_project_pin_save_failed'),
            },
            renderProjectSidebarBadge: project => {
              const enabled = standInProjects.has(
                `${project.project_store === 'local' ? 'local' : 'cloud'}:${project.id}`
              )
              if (!enabled) return null

              return (
                <span
                  className="collaboration-project-sidebar-badge flex shrink-0 text-text-secondary"
                  title={t('standIn.project_enabled')}
                  aria-label={t('standIn.project_enabled')}
                  data-testid={`stand-in-project-${project.id}`}
                >
                  <StandInIcon enabled className="h-4 w-4" />
                </span>
              )
            },
            currentUser: {
              id: Number(props.user.id),
              name: collaborationUserName,
            },
            cloudAccess: {
              authenticated: cloudConnection.isConnected,
              requestLogin: () => setCloudLoginIntent('general'),
            },
            renderExecutionEnvironmentPreferences: () => <DefaultRunnerSetting />,
            renderIssueComposer: composerProps => (
              <WeworkIssueHomeComposer
                {...composerProps}
                renderTaskComposer={draft => {
                  const project = draft.projects.find(item => item.id === draft.projectId)
                  const taskApi = project?.project_store === 'local' ? localProjectApi : api
                  return taskApi ? (
                    <PersonalHomeTaskComposer
                      draft={draft}
                      api={taskApi}
                      services={props.services}
                      drafts={personalHomeTaskDrafts}
                    />
                  ) : null
                }}
              />
            ),
            loadProjectCollaborationGroupGenerationModels,
            generateProjectCollaborationGroupDraft: (input, onProgress, onEvent) =>
              generateCollaborationGroupDraft({
                input,
                textGenerationApi: props.services.textGenerationApi,
                onProgress,
                onEvent,
              }),
            location,
            capabilities: {
              automation: true,
              dingtalkAitable: true,
              projectLocation: cloudConnection.isConnected ? 'cloud' : 'local',
              workspaceLocations: ['local', 'cloud'],
              sidebarPresentation: 'full',
              projectNavigation: 'projects',
            },
            navigate: navigatePlatform,
            manageResource: (kind, resourceId, source) => {
              if (kind === 'environments') {
                props.onOpenSettings?.(resolveDeviceResourceSettingsOptions(resourceId, source))
                return
              }
              setLocation(current => ({
                ...current,
                collaborationDomain: source ?? current.collaborationDomain,
                rootView: current.workspaceId ? current.rootView : 'agents',
                workspaceView: current.workspaceId ? 'agents' : 'home',
                projectId: null,
                projectSettingsSection: null,
                issueId: null,
              }))
            },
            renderDeviceCreator: ({ source, workspaceId, hasCloudDevice, onClose, onCreated }) =>
              source === 'cloud' && workspaceId && api?.workspaces?.registerRunner ? (
                <WorkspaceRunnerRegistrationDialog
                  workspaceId={workspaceId}
                  register={api.workspaces.registerRunner}
                  onClose={onClose}
                  onDone={() => onCreated()}
                />
              ) : source === 'cloud' ? (
                <AddCloudDeviceDialog
                  open
                  cloudConnection={cloudConnection}
                  hasCloudDevice={hasCloudDevice}
                  onClose={onClose}
                  onCreated={(_devices, createdDeviceId) => onCreated(createdDeviceId)}
                />
              ) : (
                <div
                  className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 p-4"
                  data-testid="local-device-resource-dialog"
                  role="presentation"
                  onClick={event => {
                    if (event.target === event.currentTarget) onClose()
                  }}
                >
                  <DialogSurface
                    onClose={onClose}
                    render={
                      <section
                        aria-labelledby="local-device-resource-title"
                        className="w-full max-w-lg rounded-lg border border-border bg-popover p-5 shadow-lg"
                      />
                    }
                  >
                    <h2
                      id="local-device-resource-title"
                      className="text-sm font-semibold text-text-primary"
                    >
                      {locale === 'zh-CN' ? '本地设备' : 'Local device'}
                    </h2>
                    <p className="mt-2 text-sm leading-6 text-text-secondary">
                      {locale === 'zh-CN'
                        ? '当前设备已自动加入个人分组，无需重复创建。安装并启用本机执行环境后，智能体和协作小组即可在这台设备上运行。'
                        : 'This device is already part of your personal group. Install and enable its execution environments to run Agents and teams locally.'}
                    </p>
                    <div className="mt-5 flex justify-end">
                      <ControlButton
                        variant="unstyled"
                        className="inline-flex h-8 items-center rounded-md bg-text-primary px-4 text-sm text-background"
                        data-testid="local-device-resource-confirm"
                        onClick={onClose}
                        type="button"
                      >
                        {locale === 'zh-CN' ? '知道了' : 'Done'}
                      </ControlButton>
                    </div>
                  </DialogSurface>
                </div>
              ),
            renderProjectImporter: props.renderLocalProjectImporter
              ? ({ mode, projects: collaborationProjects, onClose, onImported }) => {
                  const importedRuntimeProjectKeys = new Set(
                    collaborationProjects.flatMap(project => {
                      const key = project.metadata?.code_project_key
                      return typeof key === 'string' ? [key] : []
                    })
                  )
                  const importedWorkspaceRoots = new Set(
                    collaborationProjects.flatMap(projectWorkspaceRoots)
                  )
                  const runtimeProjectIdentitiesById = new Map(
                    (props.runtimeWork?.projects ?? []).map(projectWork => [
                      runtimeProjectUiId(projectWork.project),
                      {
                        key: projectWork.project.key,
                        roots: Array.from(
                          new Set([
                            ...(projectWork.project.roots ?? []).map(root => root.path),
                            ...projectWork.deviceWorkspaces
                              .filter(workspace => workspace.workspaceKind !== 'chat')
                              .map(workspace => workspace.workspacePath),
                          ])
                        )
                          .map(normalizeWorkspaceRoot)
                          .filter(Boolean),
                      },
                    ])
                  )
                  const availableProjects = props.localProjects.filter(project => {
                    const runtimeProject = runtimeProjectIdentitiesById.get(project.id)
                    if (runtimeProject && importedRuntimeProjectKeys.has(runtimeProject.key)) {
                      return false
                    }
                    const workspacePath =
                      project.config?.workspace?.source === 'local_path' &&
                      typeof project.config.workspace.localPath === 'string'
                        ? normalizeWorkspaceRoot(project.config.workspace.localPath)
                        : null
                    const workspaceRoots = new Set([
                      ...(runtimeProject?.roots ?? []),
                      ...(workspacePath ? [workspacePath] : []),
                    ])
                    return ![...workspaceRoots].some(root => importedWorkspaceRoots.has(root))
                  })
                  return props.renderLocalProjectImporter!({
                    mode,
                    projects: availableProjects,
                    onClose,
                    onCreated: async (runtimeProjectKey, projectName, workspaceRoots) => {
                      const localDeliveryApi = props.services.projectSpaceApis?.local
                      if (!localDeliveryApi?.importLocalCodeProject) {
                        throw new Error(
                          locale === 'zh-CN'
                            ? '本地协作服务当前不可用'
                            : 'The local collaboration service is unavailable'
                        )
                      }
                      const importedProject = await localDeliveryApi.importLocalCodeProject({
                        runtimeProjectKey,
                        name: projectName,
                        roots: workspaceRoots,
                      })
                      if (!localProjectApi) {
                        throw new Error(
                          locale === 'zh-CN'
                            ? '本地协作服务当前不可用'
                            : 'The local collaboration service is unavailable'
                        )
                      }
                      const currentProject = await localProjectApi.projects.get(
                        String(importedProject.id)
                      )
                      await onImported({
                        ...currentProject,
                        workspace_id: LOCAL_WORKSPACE_ID,
                      })
                    },
                  })
                }
              : undefined,
            sidebarHeaderActions: (
              <Tooltip label={t('todo.search_issues', '搜索 Issue')}>
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid="collaboration-issue-search-open"
                  aria-label={t('todo.search_issues', '搜索 Issue')}
                  onClick={() => setIssueSearchOpen(true)}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-secondary hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus"
                >
                  <Search className="h-4 w-4" />
                </ControlButton>
              </Tooltip>
            ),
            workspaceOwnerOptions,
            projectAgentConfiguration,
          }}
          sidebarFooter={
            props.onOpenSettings && props.onLogout ? (
              <DesktopSidebarAccount
                user={props.user}
                onOpenSettings={props.onOpenSettings}
                onLogout={props.onLogout}
              />
            ) : null
          }
          renderProject={({ project, workspace }) => {
            const projectApi = project.project_store === 'local' ? localProjectApi : api
            if (!projectApi) return null
            const runtimePort = issueRuntimePort(project.project_store, props.services)
            return (
              <WeworkSharedProject
                workspaceActive={props.workspaceActive}
                api={projectApi}
                projectCatalogApi={platformApi?.projects}
                detailServices={
                  props.services.projectSpaceDetailServices?.[
                    project.project_store === 'local' ? 'local' : 'cloud'
                  ]
                }
                devices={props.devices}
                focusedCommentId={props.focusedCommentId}
                focusedCommentRequestKey={props.focusedCommentRequestKey}
                focusedItemId={props.focusedItemId}
                localProjects={props.localProjects}
                locale={locale}
                location={location}
                onFocusedItemHandled={props.onFocusedItemHandled}
                onOpenSettings={props.onOpenSettings}
                onOpenStandInSettings={(roleId, deviceId) => {
                  const query = new URLSearchParams({
                    profileId: roleId,
                    deviceId,
                    settingsRequest: crypto.randomUUID(),
                  })
                  navigateTo(`/stand-in?${query}`)
                }}
                onOpenRuntimeTask={props.onOpenRuntimeTask}
                sendRuntimePaneMessage={props.sendRuntimePaneMessage}
                project={project}
                onOpenProjectConversation={() => openProjectConversation(project)}
                conversationRequestKey={
                  conversationRequest?.projectId === project.id &&
                  conversationRequest.projectStore === project.project_store &&
                  conversationRequest.accountScope === templateScope
                    ? conversationRequest.key
                    : undefined
                }
                runtimeTaskLifecycle={props.runtimeTaskLifecycle}
                runtimeWork={props.runtimeWork}
                runtimePort={runtimePort}
                services={props.services}
                setLocation={setLocation}
                userId={props.user.id}
                workspace={workspace}
              />
            )
          }}
        />
      </IndependentIssuesProvider>
      <WeworkCollaborationEmbeddedBrowserHost workspaceActive={props.workspaceActive ?? true} />
    </div>
  )
}
