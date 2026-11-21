// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type {
  CollaborationProject,
  CollaborationWorkspaceMember,
  CollaborationOwnedAgent,
  CollaborationGroup,
  CollaborationPlatformResources,
} from '../types'
import type { CollaborationTemplate } from '../templates/types'
import type { CollaborationPlatformHostAdapter, CollaborationDomain } from './types'
import type { PlatformMessages } from './platformMessages'
import type { useCollaborationPlatformController } from './useCollaborationPlatformController'

type Mode = 'blank' | 'folder' | 'existing'
type Controller = ReturnType<typeof useCollaborationPlatformController>
export interface PlatformCreationInput extends Controller {
  host: CollaborationPlatformHostAdapter
  messages: PlatformMessages
  ownsPageRequests: boolean
  onReady?(): void
}
interface CreationSnapshot {
  workspaceDialogOpen: boolean
  projectDialogOpen: boolean
  standaloneProjectLocation: CollaborationDomain
  projectTemplate: CollaborationTemplate | null
  projectImporter: { workspaceId: string; mode: 'folder' | 'existing' } | null
  projectWorkspaceId: string | null
  projectWorkspaceMembers: CollaborationWorkspaceMember[]
  projectWorkspaceAgents: CollaborationOwnedAgent[]
  projectWorkspaceGroups: CollaborationGroup[]
  projectCreationResources: CollaborationPlatformResources
  projectEnvironmentLoading: boolean
  projectEnvironmentError: boolean
  workspacePickerOpen: boolean
  pendingProjectMode: Mode
  createProjectAfterWorkspace: boolean
}

/** Project-creation intent, catalogs and host requests share one account-scoped owner. */
export function createPlatformCreationState(
  api: SharedWorkspaceApi,
  initial: PlatformCreationInput
) {
  let input: PlatformCreationInput | undefined = initial
  let snapshot: CreationSnapshot = {
    workspaceDialogOpen: false,
    projectDialogOpen: false,
    standaloneProjectLocation: 'local',
    projectTemplate: null,
    projectImporter: null,
    projectWorkspaceId: null,
    projectWorkspaceMembers: [],
    projectWorkspaceAgents: [],
    projectWorkspaceGroups: [],
    projectCreationResources: { agents: [], execution_environments: [] },
    projectEnvironmentLoading: false,
    projectEnvironmentError: false,
    workspacePickerOpen: false,
    pendingProjectMode: 'blank',
    createProjectAfterWorkspace: false,
  }
  const observers = new Set<() => void>()
  let resourceRequest = 0
  let generation = 0
  let workspaceIntent = 0
  let detached = false
  let handledTemplate: string | undefined
  let readyInput:
    | (Pick<PlatformCreationInput, 'onReady' | 'ownsPageRequests'> & {
        loading: boolean
        error: string | null
      })
    | undefined
  let selectedDraft: CollaborationPlatformHostAdapter['issueHomeDraft']
  let selectedDefault: CollaborationProject | undefined
  const publish = (patch: Partial<CreationSnapshot>) => {
    snapshot = { ...snapshot, ...patch }
    observers.forEach(listener => listener())
  }
  const loadResources = () => {
    const request = ++resourceRequest
    publish({
      projectWorkspaceMembers: [],
      projectWorkspaceAgents: [],
      projectWorkspaceGroups: [],
      projectCreationResources: { agents: [], execution_environments: [] },
      projectEnvironmentLoading: snapshot.projectDialogOpen && Boolean(api.resources),
      projectEnvironmentError: false,
    })
    if (!snapshot.projectDialogOpen) return
    const current = () => request === resourceRequest && observers.size > 0
    if (api.resources)
      void api.resources
        .list()
        .then(
          resources => {
            if (current()) publish({ projectCreationResources: resources })
          },
          () => {
            if (current()) publish({ projectEnvironmentError: true })
          }
        )
        .finally(() => {
          if (current()) publish({ projectEnvironmentLoading: false })
        })
    const workspaceId = snapshot.projectWorkspaceId
    if (workspaceId && api.workspaces)
      void Promise.all([
        api.workspaces.listMembers(workspaceId),
        api.workspaces.listAgents(workspaceId),
        api.workspaces.listCollaborationGroups(workspaceId),
      ]).then(
        ([members, agents, groups]) => {
          if (current())
            publish({
              projectWorkspaceMembers: members,
              projectWorkspaceAgents: agents,
              projectWorkspaceGroups: groups,
            })
        },
        () => {
          if (current())
            publish({
              projectWorkspaceMembers: [],
              projectWorkspaceAgents: [],
              projectWorkspaceGroups: [],
            })
        }
      )
  }
  const openWorkspaceProjectCreator = (workspaceId: string, mode: Mode = 'blank') => {
    if (!input) return
    const workspace =
      input.state.workspaces.find(item => item.id === workspaceId) ??
      (input.state.workspace?.id === workspaceId ? input.state.workspace : null)
    if (mode !== 'blank' && workspace?.location === 'local' && input.host.renderProjectImporter) {
      publish({ projectImporter: { workspaceId, mode } })
      return
    }
    publish({ projectWorkspaceId: workspaceId, projectDialogOpen: true })
    loadResources()
  }
  const startStandaloneProjectCreation = (location: CollaborationDomain, mode: Mode = 'blank') => {
    if (!input) return
    const { host, state, messages } = input
    if (location === 'cloud' && host.cloudAccess?.authenticated === false) {
      host.cloudAccess.requestLogin()
      return
    }
    publish({ standaloneProjectLocation: location })
    const localWorkspace = state.workspaces.find(item => item.location === 'local')
    if (location === 'local' && localWorkspace) {
      openWorkspaceProjectCreator(localWorkspace.id, mode)
      return
    }
    if (location === 'local') {
      host.notify?.(messages.navigationLoadFailed, 'error')
      return
    }
    const defaultWorkspace = state.workspaces.find(
      item => item.location === 'cloud' && item.is_system_default && item.access_role === 'Owner'
    )
    publish({ projectWorkspaceId: defaultWorkspace?.id ?? null, projectDialogOpen: true })
    loadResources()
  }
  const startProjectCreation = (mode: Mode = 'blank', templateRequested = false) => {
    if (!input) return
    const { host, state } = input
    if (
      !templateRequested &&
      host.capabilities.projectNavigation === 'projects' &&
      !host.location.workspaceId
    ) {
      startStandaloneProjectCreation(
        mode === 'blank' ? (host.capabilities.projectLocation ?? 'local') : 'local',
        mode
      )
      return
    }
    if (
      host.location.workspaceId &&
      state.workspace &&
      (mode === 'blank' || state.workspace.location === 'local')
    ) {
      openWorkspaceProjectCreator(state.workspace.id, mode)
      return
    }
    const candidates =
      mode === 'blank'
        ? state.workspaces
        : state.workspaces.filter(item => item.location === 'local')
    if (candidates.length === 1) {
      openWorkspaceProjectCreator(candidates[0].id, mode)
      return
    }
    publish({ pendingProjectMode: mode, workspacePickerOpen: true })
  }
  const closeProject = () => {
    publish({ projectDialogOpen: false, projectTemplate: null, projectWorkspaceId: null })
    loadResources()
  }
  return {
    getSnapshot: () => snapshot,
    isAccountCurrent: () => observers.size > 0,
    subscribe(next: PlatformCreationInput, listener: () => void) {
      input = next
      observers.add(listener)
      if (detached) {
        detached = false
        readyInput = undefined
        if (snapshot.projectDialogOpen) loadResources()
      }
      const { host, state, ownsPageRequests, onReady } = next
      const readyChanged =
        !readyInput ||
        readyInput.onReady !== onReady ||
        readyInput.ownsPageRequests !== ownsPageRequests ||
        readyInput.loading !== state.loading ||
        readyInput.error !== state.error
      readyInput = { onReady, ownsPageRequests, loading: state.loading, error: state.error }
      if (readyChanged && (ownsPageRequests || (!state.loading && !state.error))) onReady?.()
      const projectIds = new Set(state.workspaces.map(item => item.id))
      const projects = state.projects.filter(
        item =>
          host.capabilities.projectNavigation === 'projects' ||
          Boolean(item.workspace_id && projectIds.has(item.workspace_id))
      )
      const defaultProject = projects[0]
      if (selectedDraft !== host.issueHomeDraft || selectedDefault !== defaultProject) {
        selectedDraft = host.issueHomeDraft
        selectedDefault = defaultProject
        if (host.issueHomeDraft && !host.issueHomeDraft.projectId && defaultProject)
          host.issueHomeDraft.onSelectProject(defaultProject.id)
      }
      const request = host.projectTemplateRequest
      if (request && !state.loading && !state.error && handledTemplate !== request.key) {
        handledTemplate = request.key
        publish({ projectTemplate: request.document })
        startProjectCreation('blank', true)
        request.onHandled()
      }
      return () => {
        observers.delete(listener)
        queueMicrotask(() => {
          if (observers.size) return
          detached = true
          generation += 1
          resourceRequest += 1
          if (snapshot.projectEnvironmentLoading) publish({ projectEnvironmentLoading: false })
        })
      }
    },
    scopedApi(workspaceId: string | null, projectId: string | null): SharedWorkspaceApi {
      if (!workspaceId) return api
      return {
        ...api,
        projects: {
          ...api.projects,
          list: async () => {
            await Promise.resolve()
            if (!observers.size) throw new Error('Project navigation scope is no longer active')
            const selected = projectId
              ? input?.state.navigationProjects.find(item => item.id === projectId)
              : undefined
            if (selected) return [selected]
            const fullAccess = input?.state.workspace?.id === workspaceId
            const projects = await (fullAccess
              ? api.projects.list(workspaceId)
              : api.projects.list())
            return fullAccess || !projectId
              ? projects
              : projects.filter(item => item.id === projectId)
          },
          create: data => api.projects.create({ ...data, workspaceId }),
        },
      }
    },
    startProjectCreation,
    startStandaloneProjectCreation,
    openWorkspaceProjectCreator,
    useTemplate(document: CollaborationTemplate) {
      publish({ projectTemplate: document })
      startProjectCreation()
    },
    openWorkspaceDialog() {
      workspaceIntent += 1
      publish({ createProjectAfterWorkspace: false, workspaceDialogOpen: true })
    },
    closeWorkspaceDialog() {
      workspaceIntent += 1
      publish({
        workspaceDialogOpen: false,
        createProjectAfterWorkspace: false,
        projectTemplate: null,
      })
    },
    async createWorkspace(data: Parameters<Controller['commands']['createWorkspace']>[0]) {
      if (!input) return
      const version = generation
      const intent = workspaceIntent
      const workspace = await input.commands.createWorkspace(data)
      if (!observers.size || generation !== version || workspaceIntent !== intent || !input) return
      publish({ workspaceDialogOpen: false })
      if (snapshot.createProjectAfterWorkspace) {
        publish({
          createProjectAfterWorkspace: false,
          projectWorkspaceId: workspace.id,
          projectDialogOpen: true,
        })
        loadResources()
        return
      }
      input.host.navigate({
        ...input.host.location,
        workspaceId: workspace.id,
        workspaceView: 'home',
        projectId: null,
        issueId: null,
      })
    },
    closeWorkspacePicker() {
      publish({ workspacePickerOpen: false, projectTemplate: null })
    },
    createPickerWorkspace() {
      workspaceIntent += 1
      publish({
        workspacePickerOpen: false,
        createProjectAfterWorkspace: true,
        workspaceDialogOpen: true,
      })
    },
    selectPickerWorkspace(workspaceId: string) {
      publish({ workspacePickerOpen: false })
      openWorkspaceProjectCreator(workspaceId, snapshot.pendingProjectMode)
    },
    closeImporter() {
      publish({ projectImporter: null })
    },
    async resourceSaved(refreshCreationCatalog = false) {
      if (!observers.size || !input) return
      const version = generation
      await input.commands.reload()
      if (!observers.size || version !== generation || !input) return
      if (refreshCreationCatalog) loadResources()
      input.host.notify?.(input.messages.resourceSaved, 'success')
    },
    async archiveProject(project: CollaborationProject) {
      if (!observers.size || !input) return
      const version = generation
      await input.commands.archiveProject(project)
      if (!observers.size || version !== generation || !input) return
      if (input.host.location.projectId === project.id)
        input.host.navigate({
          platformView: 'spaces',
          workspaceId: project.workspace_id ?? null,
          workspaceView: 'projects',
          projectId: null,
          projectView: 'board',
          issueId: null,
        })
    },
    assertProjectCreationActive() {
      if (!observers.size || !snapshot.projectDialogOpen)
        throw new Error('Project creation scope is no longer active')
    },
    acceptProjectCreated(project: CollaborationProject) {
      if (!observers.size || !snapshot.projectDialogOpen || !input) return
      input.commands.registerProject(project)
      closeProject()
      const workspace = input.state.workspaces.find(item => item.id === project.workspace_id)
      input.host.navigate({
        ...input.host.location,
        collaborationDomain:
          workspace?.location ?? (project.project_store === 'local' ? 'local' : 'cloud'),
        workspaceId: project.workspace_id ?? null,
        workspaceView: 'projects',
        projectId: project.id,
        projectView: 'board',
        projectSettingsSection: null,
        issueId: null,
      })
    },
    closeProject,
    selectProjectWorkspace(workspaceId: string) {
      publish({
        projectTemplate: null,
        standaloneProjectLocation: 'cloud',
        projectWorkspaceId: workspaceId || null,
      })
      loadResources()
    },
    refreshResources: loadResources,
  }
}
