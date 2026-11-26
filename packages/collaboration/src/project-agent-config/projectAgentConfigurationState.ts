import type { CollaborationTranslate } from '../i18n'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationOwnedAgent, CollaborationProject } from '../types'
import { requestFailureMessage as errorMessage } from '../controls/requestFailure'
import {
  createResourceAgentBindingInput,
  createSharedAgentBindingInput,
  isSelectableAgentResource,
  normalizeProjectAgent,
  type ProjectAgentConfigurationRecord,
} from './model'
import type { ProjectAgentMode } from './types'

export interface ProjectAgentConfigurationScope {
  api: SharedWorkspaceApi
  projectId: CollaborationProject['id']
  workspaceId: CollaborationProject['workspace_id']
  namespace: string
  projectStore: CollaborationProject['project_store']
  role: CollaborationProject['workspace_access_role']
  canManage: boolean
  scope: 'project' | 'workspace'
}
export interface ProjectAgentConfigurationInput {
  translate: CollaborationTranslate
  onError(): void
  onAgentsChange?(): void
  supportsExisting: boolean
  openComposerRequestId?: number
  onOpenComposerRequestConsumed?(requestId: number): void
}
interface Snapshot {
  agents: ProjectAgentConfigurationRecord[]
  workspaceAgents: CollaborationOwnedAgent[]
  selectedTeamId: string
  mode: ProjectAgentMode
  loading: boolean
  loadError: string | null
  candidateLoading: boolean
  candidateError: string | null
  composerOpen: boolean
  composerVersion: number
  editingVersion: number
  editingAgentId: string | null
  pendingRemoval: ProjectAgentConfigurationRecord | null
  busy: boolean
  archivingId: string | null
  error: string | null
  canBrowseSources: boolean
  legacySourceAccessPending: boolean
}
interface Observer {
  listener(): void
  input: ProjectAgentConfigurationInput
}

/** One permission/storage scope owns its configured Agents, deferred candidates and editor workflow. */
export function createProjectAgentConfigurationState(identity: ProjectAgentConfigurationScope) {
  const { api, projectId, workspaceId, projectStore, role, canManage, scope } = identity
  const requiresLegacyAccess =
    canManage &&
    scope === 'project' &&
    projectStore !== 'local' &&
    role === undefined &&
    Boolean(workspaceId && api.workspaces)
  const observers = new Set<Observer>()
  let input: ProjectAgentConfigurationInput | undefined
  let state: Snapshot = {
    agents: [],
    workspaceAgents: [],
    selectedTeamId: '',
    mode: 'existing',
    loading: true,
    loadError: null,
    candidateLoading: true,
    candidateError: null,
    composerOpen: false,
    composerVersion: 0,
    editingVersion: 0,
    editingAgentId: null,
    pendingRemoval: null,
    busy: false,
    archivingId: null,
    error: null,
    canBrowseSources:
      canManage && (scope === 'workspace' || projectStore === 'local' || Boolean(role)),
    legacySourceAccessPending: requiresLegacyAccess,
  }
  let started = false
  let generation = 0
  let listVersion = 0
  let candidateVersion = 0
  let accessVersion = 0
  let candidateOwner: number | null = null
  let busyWrites = 0
  let archiveVersion = 0
  let createdVersion = 0
  const createdDuringReads = new Map<
    string,
    { version: number; agent: ProjectAgentConfigurationRecord }
  >()
  const consumedComposerRequests = new Set<number>()
  const owned = (owner = generation) => owner === generation && observers.size > 0
  const defaultMode = (): ProjectAgentMode =>
    input?.supportsExisting === false ? 'create' : 'existing'
  function publish(change: Partial<Snapshot>) {
    if (Object.entries(change).every(([key, value]) => state[key as keyof Snapshot] === value))
      return
    state = { ...state, ...change }
    for (const observer of [...observers]) if (observers.has(observer)) observer.listener()
  }
  function notify(kind: 'error' | 'agents') {
    for (const observer of [...observers]) {
      if (!observers.has(observer)) continue
      if (kind === 'error') observer.input.onError()
      else observer.input.onAgentsChange?.()
    }
  }
  const translate = (key: string, fallback: string) => input?.translate(key, fallback) ?? fallback
  function reportAction(cause: unknown, key: string, fallback: string) {
    publish({ error: errorMessage(cause, translate(key, fallback)) })
    notify('error')
  }
  function reportLoad(cause: unknown) {
    publish({
      loadError: errorMessage(
        cause,
        translate('todo.load_project_agents_failed', '加载项目智能体配置失败')
      ),
    })
    notify('error')
  }
  async function reloadAgents(failure: 'list' | 'throw' = 'throw') {
    if (!owned()) return false
    const owner = generation
    const request = ++listVersion
    const creationAtStart = createdVersion
    const current = () => owned(owner) && request === listVersion
    try {
      const rows = await api.agents.list(projectId, {
        includeArchived: canManage && scope === 'project',
      })
      if (!current()) return false
      const agents = rows
        .map(normalizeProjectAgent)
        .filter(agent => canManage || agent.status !== 'archived')
      // A list begun before a successful create must not erase the newly bound Agent.
      for (const created of createdDuringReads.values()) {
        if (
          created.version <= creationAtStart ||
          agents.some(agent => agent.id === created.agent.id)
        )
          continue
        agents.push(created.agent)
      }
      createdDuringReads.clear()
      publish({ loadError: null, agents })
      return true
    } catch (cause) {
      if (!current()) return false
      if (failure === 'list') reportLoad(cause)
      else throw cause
      return false
    } finally {
      if (current()) publish({ loading: false })
    }
  }
  function retryList() {
    if (!owned()) return
    candidateVersion += 1
    candidateOwner = null
    publish({
      workspaceAgents: [],
      candidateError: null,
      selectedTeamId: '',
      composerOpen: false,
      editingAgentId: null,
      pendingRemoval: null,
      error: null,
      loadError: null,
      loading: true,
    })
    void reloadAgents('list')
  }
  async function loadAccess() {
    if (!requiresLegacyAccess || !api.workspaces || !owned()) return
    const owner = generation
    const version = ++accessVersion
    const current = () => owned(owner) && version === accessVersion
    try {
      const workspaces = await api.workspaces.list()
      if (!current()) return
      publish({
        canBrowseSources: workspaces.some(workspace => workspace.id === workspaceId),
        legacySourceAccessPending: false,
      })
    } catch (cause) {
      if (!current()) return
      publish({ canBrowseSources: false, legacySourceAccessPending: false })
      reportAction(cause, 'todo.load_project_agents_failed', '加载项目智能体配置失败')
    }
    if (current()) consumeComposerRequest()
  }
  function cancelCandidates() {
    candidateVersion += 1
    candidateOwner = null
  }
  function loadCandidates() {
    if (
      !owned() ||
      !state.composerOpen ||
      state.mode !== 'existing' ||
      !state.canBrowseSources ||
      !input?.supportsExisting
    )
      return
    const owner = generation
    const request = ++candidateVersion
    candidateOwner = request
    const current = () =>
      owned(owner) &&
      candidateVersion === request &&
      state.composerOpen &&
      state.mode === 'existing' &&
      state.canBrowseSources
    publish({ candidateLoading: true, candidateError: null })
    void Promise.all([
      api.resources?.list() ?? { agents: [], execution_environments: [] },
      workspaceId && api.workspaces ? api.workspaces.listAgents(workspaceId) : [],
    ])
      .then(([personal, workspace]) => {
        if (!current()) return
        const selectable = new Map<string, CollaborationOwnedAgent>()
        for (const agent of [...personal.agents, ...workspace]) {
          const locationMatches =
            projectStore === 'local' ? agent.location === 'local' : agent.location !== 'local'
          if (
            locationMatches &&
            isSelectableAgentResource(agent) &&
            (agent.team_id || agent.project_binding_input)
          )
            selectable.set(String(agent.team_id ?? agent.id), agent)
        }
        publish({ workspaceAgents: [...selectable.values()] })
      })
      .catch(cause => {
        if (!current()) return
        publish({
          candidateError: errorMessage(
            cause,
            translate('todo.load_project_agents_failed', '加载项目智能体配置失败')
          ),
        })
        notify('error')
      })
      .finally(() => {
        if (current()) publish({ candidateLoading: false })
      })
  }
  function openComposer() {
    if (!owned() || !state.canBrowseSources) return
    cancelCandidates()
    publish({
      mode: defaultMode(),
      selectedTeamId: '',
      candidateLoading: true,
      candidateError: null,
      error: null,
      composerVersion: state.composerVersion + 1,
      composerOpen: true,
    })
    loadCandidates()
  }
  function closeComposer(resetMode = false, expectedVersion = state.composerVersion) {
    if (!owned() || expectedVersion !== state.composerVersion) return
    cancelCandidates()
    publish({ composerOpen: false, ...(resetMode ? { mode: defaultMode() } : {}) })
  }
  function consumeComposerRequest() {
    const requestId = input?.openComposerRequestId
    if (
      !owned() ||
      requestId === undefined ||
      state.legacySourceAccessPending ||
      consumedComposerRequests.has(requestId)
    )
      return
    consumedComposerRequests.add(requestId)
    if (state.canBrowseSources) openComposer()
    for (const observer of [...observers])
      if (observers.has(observer)) observer.input.onOpenComposerRequestConsumed?.(requestId)
  }
  async function addAgent(binding: Record<string, unknown>, rethrow = false) {
    if (!owned() || !canManage || !state.canBrowseSources) return false
    const owner = generation
    busyWrites += 1
    publish({ busy: true, error: null })
    try {
      const created = await api.agents.create(projectId, binding)
      if (!owned(owner)) return false
      const agent = normalizeProjectAgent(created)
      createdDuringReads.set(agent.id, { version: ++createdVersion, agent })
      publish({ agents: [...state.agents, agent] })
      notify('agents')
      return owned(owner)
    } catch (cause) {
      if (!owned(owner)) return false
      reportAction(cause, 'todo.create_project_agent_failed', '创建项目智能体失败')
      if (rethrow) throw cause
      return false
    } finally {
      if (owned(owner)) {
        busyWrites -= 1
        publish({ busy: busyWrites > 0 })
      }
    }
  }
  async function finishAgentChange(editor?: { id: string; version: number }) {
    if (!owned() || !canManage) return
    if (editor && editor.id === state.editingAgentId && editor.version === state.editingVersion)
      publish({ editingAgentId: null, editingVersion: state.editingVersion + 1 })
    notify('agents')
    if (owned()) await reloadAgents('list')
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void, next: ProjectAgentConfigurationInput) {
      input = next
      const observer = { listener, input: next }
      observers.add(observer)
      if (!next.supportsExisting && state.mode === 'existing') {
        cancelCandidates()
        publish({ mode: 'create', composerVersion: state.composerVersion + 1 })
      }
      if (!started) {
        started = true
        retryList()
        if (requiresLegacyAccess) {
          publish({ legacySourceAccessPending: true, canBrowseSources: false })
          void loadAccess()
        }
      }
      consumeComposerRequest()
      if (state.composerOpen && state.mode === 'existing' && candidateOwner === null)
        loadCandidates()
      return () => {
        observers.delete(observer)
        queueMicrotask(() => {
          if (observers.size > 0) return
          generation += 1
          listVersion += 1
          accessVersion += 1
          cancelCandidates()
          busyWrites = 0
          started = false
          state = { ...state, busy: false, archivingId: null }
        })
      }
    },
    retryList,
    openComposer,
    closeComposer: (expectedVersion?: number) => closeComposer(false, expectedVersion),
    cancelCreation: (expectedVersion?: number) => closeComposer(true, expectedVersion),
    selectTeam(selectedTeamId: string) {
      if (owned() && state.canBrowseSources) publish({ selectedTeamId })
    },
    createAgent() {
      if (owned() && state.canBrowseSources) {
        cancelCandidates()
        publish({ mode: 'create' })
      }
    },
    retryCandidates: loadCandidates,
    editAgent(id: string) {
      if (owned() && canManage && state.agents.some(agent => agent.id === id && agent.canEdit))
        publish({ editingAgentId: id, editingVersion: state.editingVersion + 1 })
    },
    closeEditor(expectedVersion = state.editingVersion) {
      if (owned() && expectedVersion === state.editingVersion)
        publish({ editingAgentId: null, editingVersion: state.editingVersion + 1 })
    },
    requestRemoval(agent: ProjectAgentConfigurationRecord) {
      if (owned() && canManage && scope === 'project' && agent.deletable)
        publish({ pendingRemoval: agent })
    },
    cancelRemoval(agent: ProjectAgentConfigurationRecord) {
      if (owned() && state.pendingRemoval?.id === agent.id) publish({ pendingRemoval: null })
    },
    async addExistingAgent(expectedVersion = state.composerVersion) {
      if (
        expectedVersion !== state.composerVersion ||
        state.candidateLoading ||
        state.candidateError
      )
        return
      const selected = state.workspaceAgents.find(
        agent => String(agent.team_id ?? agent.id) === state.selectedTeamId
      )
      if (
        !selected ||
        state.agents.some(
          agent => selected.team_id != null && agent.wegentTeamId === selected.team_id
        )
      )
        return
      const owner = generation
      if ((await addAgent(createResourceAgentBindingInput(selected))) && owned(owner)) {
        if (expectedVersion === state.composerVersion) publish({ selectedTeamId: '' })
        closeComposer(false, expectedVersion)
      }
    },
    async createAndAddAgent(
      agent: { name: string; teamId: number },
      expectedVersion = state.composerVersion
    ) {
      const owner = generation
      if (
        (await addAgent(
          createSharedAgentBindingInput({ name: agent.name, team_id: agent.teamId }),
          true
        )) &&
        owned(owner)
      )
        closeComposer(true, expectedVersion)
    },
    async finishLocalAgentCreation(expectedVersion = state.composerVersion) {
      if (!owned() || !canManage || !state.canBrowseSources) return
      const owner = generation
      publish({ error: null })
      try {
        await reloadAgents()
        if (!owned(owner)) return
        closeComposer(true, expectedVersion)
        notify('agents')
      } catch (cause) {
        if (!owned(owner)) return
        reportAction(cause, 'todo.load_project_agents_failed', '加载项目智能体配置失败')
        throw cause
      }
    },
    finishAgentChange,
    async saveEditedAgent(
      saved: { name: string; teamId: number },
      editor: { id: string; version: number }
    ) {
      const agent = state.agents.find(agent => agent.id === editor.id)
      if (!owned() || !canManage || !agent || !agent.canEdit) return
      const owner = generation
      publish({ error: null })
      try {
        if (scope === 'project')
          await api.agents.update(projectId, agent.id, {
            version: agent.version,
            ...(saved.name ? { name: saved.name } : {}),
          })
        if (owned(owner)) await finishAgentChange(editor)
      } catch (cause) {
        if (!owned(owner)) return
        reportAction(cause, 'todo.update_project_agent_failed', '更新项目智能体失败')
        throw cause
      }
    },
    async archiveAgent(agent: ProjectAgentConfigurationRecord, reactivate = false) {
      if (!owned() || !canManage || (reactivate ? scope !== 'project' : !agent.deletable)) return
      const owner = generation
      const request = ++archiveVersion
      publish({ archivingId: agent.id, error: null })
      try {
        await api.agents.update(projectId, agent.id, {
          version: agent.version,
          status: reactivate ? 'active' : 'archived',
          ...(reactivate ? { shareWithWorkspace: true } : {}),
        })
        if (!owned(owner)) return
        await reloadAgents()
        if (owned(owner)) notify('agents')
      } catch (cause) {
        if (!owned(owner)) return
        reportAction(
          cause,
          reactivate ? 'todo.update_project_agent_failed' : 'todo.archive_project_agent_failed',
          reactivate ? '更新项目智能体失败' : '停用项目智能体失败'
        )
      } finally {
        if (owned(owner) && request === archiveVersion) publish({ archivingId: null })
      }
    },
    async removeAgent(agent: ProjectAgentConfigurationRecord) {
      if (
        !owned() ||
        !canManage ||
        scope !== 'project' ||
        !agent.deletable ||
        state.pendingRemoval?.id !== agent.id
      )
        return
      const owner = generation
      try {
        await api.agents.remove(projectId, agent.id, agent.version)
        if (!owned(owner)) return
        listVersion += 1
        publish({ agents: state.agents.filter(row => row.id !== agent.id) })
        await finishAgentChange({ id: agent.id, version: state.editingVersion })
      } catch (cause) {
        if (!owned(owner)) return
        const message = errorMessage(cause, '')
        if (message.includes('PROJECT_AGENT_IN_USE'))
          throw new Error(
            translate(
              'todo.project_agent_in_use',
              '该智能体仍被协作小组引用，请先在小组中替换或移除，再删除。'
            ),
            { cause }
          )
        if (message.includes('PROJECT_AGENT_MANAGED'))
          throw new Error(
            translate('todo.project_agent_managed', '当前设备智能体由系统管理，不能删除。'),
            { cause }
          )
        throw cause
      }
    },
  }
}
