import { getRuntimeConfig } from '@/config/runtime'
import type {
  DeviceSurfaceLaunchAction,
  DeviceSurfaceWorkspaceMenuItem,
} from '@/extensions/device-surface-contract'
import type { WorkspaceSessionApi } from '@/features/workbench/workbenchServices'
import {
  closeLocalTerminal,
  getLocalExecutorDeviceId,
  localPathExists,
  startLocalTerminal,
} from '@/lib/local-terminal'
import type { ProjectWithTasks } from '@/types/api'
import {
  buildLocalTerminalEnv,
  getTerminalSessionLabel,
  type WorkspacePanelMenuActions,
  type WorkspaceTerminalSession,
  type WorkspaceTool,
} from './workspace-panel-tools'

export interface WorkspacePanelCardsContext {
  projectKey: string
  currentProject: ProjectWithTasks | null
  activeWorkspaceDeviceId?: string
  activeWorkspacePath?: string
  activeWorkspaceTaskId?: string | null
  hasWorkspaceContext: boolean
  localTerminalSupported: boolean
  localTerminalRuntimeAvailable: boolean
  localTerminalCheckKey: string
  projectTerminalAvailable: boolean
  useDeviceTerminalSession: boolean
  defaultOpenTool?: WorkspaceTool
  panelActive: boolean
  hideTerminalChrome: boolean
  terminalContextTitle?: string | null
  workspaceSessionApi?: WorkspaceSessionApi
  showTerminalEntry: boolean
  deviceSurfaceAvailable: boolean
  deviceSurfaceMenuItem: DeviceSurfaceWorkspaceMenuItem | null
  deviceOnline: boolean
  unavailableMessage: string
  startErrorMessage: string
  onTerminalTitleChange?: (title: string) => void
  onMenuActionsChange?: (actions: WorkspacePanelMenuActions | null) => void
  onRequestClose?: () => void
}
interface LocalTerminalCheck {
  key: string
  executorDeviceId: string | null
  pathExists: boolean
}
type CloseReason = 'workspace-panel-unmount' | 'workspace-target-changed' | 'user-closed-session'
interface LaunchOwner {
  version: number
  closeReason?: CloseReason
}
const emptyCheck = (): LocalTerminalCheck => ({
  key: '',
  executorDeviceId: null,
  pathExists: false,
})
function closeSession(session: WorkspaceTerminalSession, reason: CloseReason) {
  if (session.terminal_kind !== 'local') return
  void closeLocalTerminal(session.session_id, {
    reason,
    taskId: session.diagnostic_task_id,
    workspacePath: session.cwd,
  }).catch(error => console.error('Failed to close local terminal:', error))
}
function sameFields(first: object | null, second: object | null): boolean {
  if (!first || !second) return first === second
  const keys = Object.keys(first)
  return (
    keys.length === Object.keys(second).length &&
    keys.every(key => Object.is(Reflect.get(first, key), Reflect.get(second, key)))
  )
}

/** Session subscribers own native terminals; catalog subscribers consume checks, availability and launch state. */
export function createWorkspacePanelCardsState() {
  const sessionListeners = new Set<() => void>()
  const toolListeners = new Set<() => void>()
  let context: WorkspacePanelCardsContext | undefined
  let version = 0
  let launch: LaunchOwner | null = null
  let defaultOpenedKey: string | null = null
  let automaticScheduled = false
  let extensionAction: DeviceSurfaceLaunchAction | null = null
  let checkRequest: { key: string; promise: Promise<LocalTerminalCheck> } | null = null
  let sessions = {
    projectKey: '',
    terminalSessions: [] as WorkspaceTerminalSession[],
    activeTerminalSessionId: null as string | null,
  }
  let tools = {
    projectKey: '',
    availableTools: { terminal: true },
    error: null as string | null,
    loadingTool: null as WorkspaceTool | 'extension' | null,
    localTerminalCheck: emptyCheck(),
    menuActions: {
      terminal: { visible: false, disabled: true },
      extension: null,
    } as WorkspacePanelMenuActions,
  }
  let lastMenu:
    | {
        callback: WorkspacePanelCardsContext['onMenuActionsChange']
        actions: WorkspacePanelMenuActions
      }
    | undefined
  let lastTitle:
    | { callback: WorkspacePanelCardsContext['onTerminalTitleChange']; title: string }
    | undefined
  const active = () => sessionListeners.size > 0
  const scoped = (key: string) => active() && context?.projectKey === key
  const report = () => {
    if (!active() || !context) return
    if (
      !lastMenu ||
      lastMenu.callback !== context.onMenuActionsChange ||
      lastMenu.actions !== tools.menuActions
    ) {
      lastMenu = { callback: context.onMenuActionsChange, actions: tools.menuActions }
      context.onMenuActionsChange?.(tools.menuActions)
    }
    const current =
      sessions.terminalSessions.find(
        session => session.session_id === sessions.activeTerminalSessionId
      ) ??
      sessions.terminalSessions[0] ??
      null
    const title = getTerminalSessionLabel(current)
    if (!title) lastTitle = undefined
    else if (
      !lastTitle ||
      lastTitle.callback !== context.onTerminalTitleChange ||
      lastTitle.title !== title
    ) {
      lastTitle = { callback: context.onTerminalTitleChange, title }
      context.onTerminalTitleChange?.(title)
    }
  }
  const runExtension = async () => {
    await extensionAction?.({ notifyOpened: false })
  }
  const publishTools = (patch: Partial<typeof tools>) => {
    const next = { ...tools, ...patch }
    const disabled = !context?.hasWorkspaceContext || Boolean(next.loadingTool)
    const menu: WorkspacePanelMenuActions = {
      terminal: {
        visible: context?.showTerminalEntry ?? false,
        disabled: disabled || !context?.projectTerminalAvailable || !next.availableTools.terminal,
        title: context?.projectTerminalAvailable ? undefined : context?.unavailableMessage,
      },
      extension:
        context?.deviceSurfaceAvailable && context.deviceSurfaceMenuItem
          ? {
              ...context.deviceSurfaceMenuItem,
              visible: true,
              disabled: disabled || !context.deviceOnline,
              run: runExtension,
            }
          : null,
    }
    next.menuActions =
      sameFields(menu.terminal, tools.menuActions.terminal) &&
      sameFields(menu.extension, tools.menuActions.extension)
        ? tools.menuActions
        : menu
    if (!sameFields(next, tools)) {
      tools = next
      toolListeners.forEach(listener => listener())
    }
    report()
    scheduleDefault()
  }
  const publishSessions = (patch: Partial<typeof sessions>) => {
    sessions = { ...sessions, ...patch }
    sessionListeners.forEach(listener => listener())
    report()
    scheduleDefault()
  }
  const canUseCheck = (check: LocalTerminalCheck, input: WorkspacePanelCardsContext) =>
    input.localTerminalSupported &&
    input.localTerminalRuntimeAvailable &&
    check.key === input.localTerminalCheckKey &&
    (Boolean(
      input.activeWorkspaceDeviceId && check.executorDeviceId === input.activeWorkspaceDeviceId
    ) ||
      check.pathExists ||
      !input.activeWorkspacePath?.trim())
  const readCheck = (input: WorkspacePanelCardsContext): Promise<LocalTerminalCheck> => {
    if (checkRequest?.key === input.localTerminalCheckKey) return checkRequest.promise
    const promise = Promise.all([
      getLocalExecutorDeviceId(getRuntimeConfig().apiBaseUrl),
      localPathExists(input.activeWorkspacePath),
    ]).then(
      ([executorDeviceId, pathExists]) => ({
        key: input.localTerminalCheckKey,
        executorDeviceId,
        pathExists,
      }),
      () => ({ key: input.localTerminalCheckKey, executorDeviceId: null, pathExists: false })
    )
    const request = { key: input.localTerminalCheckKey, promise }
    checkRequest = request
    void promise.then(check => {
      if (active() && checkRequest === request && context?.localTerminalCheckKey === check.key)
        publishTools({ localTerminalCheck: check })
    })
    return promise
  }
  const unavailable = () =>
    publishTools({ availableTools: { terminal: false }, error: context?.startErrorMessage ?? null })
  async function startTerminal(projectKey: string) {
    const input = context
    if (
      !input ||
      !scoped(projectKey) ||
      !input.hasWorkspaceContext ||
      tools.loadingTool ||
      !input.projectTerminalAvailable ||
      !tools.availableTools.terminal
    )
      return
    const owner: LaunchOwner = { version }
    launch = owner
    const owns = () =>
      active() &&
      launch === owner &&
      owner.version === version &&
      context?.projectKey === projectKey &&
      context.localTerminalCheckKey === input.localTerminalCheckKey &&
      context.localTerminalSupported === input.localTerminalSupported &&
      context.localTerminalRuntimeAvailable === input.localTerminalRuntimeAvailable &&
      context.useDeviceTerminalSession === input.useDeviceTerminalSession
    publishTools({ loadingTool: 'terminal', error: null })
    try {
      let check = tools.localTerminalCheck
      if (
        input.localTerminalSupported &&
        input.localTerminalRuntimeAvailable &&
        check.key !== input.localTerminalCheckKey
      )
        check = await readCheck(input)
      if (!owns()) return
      if (canUseCheck(check, input)) {
        const sessionId = await startLocalTerminal({
          cwd: input.activeWorkspacePath,
          env: buildLocalTerminalEnv({
            title: input.terminalContextTitle,
            projectName: input.currentProject?.name,
            workspacePath: input.activeWorkspacePath,
          }),
          diagnosticContext: {
            taskId: input.activeWorkspaceTaskId,
            workspacePath: input.activeWorkspacePath,
          },
        })
        const session: WorkspaceTerminalSession = {
          terminal_kind: 'local',
          session_id: sessionId,
          project_id: input.currentProject?.id ?? 0,
          device_id: input.activeWorkspaceDeviceId ?? check.executorDeviceId ?? 'local',
          type: 'terminal',
          path: input.activeWorkspacePath ?? '',
          url: '',
          transport: 'socketio',
          cwd: input.activeWorkspacePath,
          diagnostic_task_id: input.activeWorkspaceTaskId ?? undefined,
        }
        if (!owns()) {
          closeSession(
            session,
            owner.closeReason ?? (active() ? 'workspace-target-changed' : 'workspace-panel-unmount')
          )
          return
        }
        publishSessions({
          terminalSessions: [...sessions.terminalSessions, session],
          activeTerminalSessionId: sessionId,
        })
        return
      }
      if (input.localTerminalSupported) {
        unavailable()
        return
      }
      const api = input.workspaceSessionApi
      if (!api) throw new Error('Remote workspace session service is unavailable')
      let started
      if (input.useDeviceTerminalSession) {
        if (!input.activeWorkspaceDeviceId || !input.activeWorkspacePath)
          throw new Error('Remote workspace target is missing')
        started = {
          ...(await api.startDeviceTerminal(
            input.activeWorkspaceDeviceId,
            input.activeWorkspacePath
          )),
          project_id: input.currentProject?.id ?? 0,
        }
      } else {
        if (!input.currentProject) return
        started = await api.startProjectTerminal(input.currentProject.id)
      }
      if (!owns() || context?.workspaceSessionApi !== api) return
      if (started.transport !== 'socketio')
        throw new Error('Terminal session transport is not supported')
      publishSessions({
        terminalSessions: [
          ...sessions.terminalSessions,
          {
            ...started,
            terminal_kind: 'remote',
            remoteClientFactory: api.createRemoteTerminalClient,
          },
        ],
        activeTerminalSessionId: started.session_id,
      })
    } catch (error) {
      if (!owns()) return
      console.error('Failed to start project terminal:', error)
      unavailable()
    } finally {
      if (launch === owner) {
        launch = null
        if (tools.loadingTool === 'terminal') publishTools({ loadingTool: null })
      }
    }
  }
  function scheduleDefault() {
    if (automaticScheduled || !active()) return
    automaticScheduled = true
    queueMicrotask(() => {
      automaticScheduled = false
      const input = context
      if (
        !input ||
        !active() ||
        input.defaultOpenTool !== 'terminal' ||
        !input.panelActive ||
        defaultOpenedKey === input.projectKey ||
        sessions.terminalSessions.length ||
        !input.hasWorkspaceContext ||
        tools.loadingTool ||
        !input.projectTerminalAvailable ||
        !tools.availableTools.terminal ||
        (input.localTerminalSupported &&
          input.localTerminalRuntimeAvailable &&
          tools.localTerminalCheck.key !== input.localTerminalCheckKey)
      )
        return
      defaultOpenedKey = input.projectKey
      void startTerminal(input.projectKey)
    })
  }
  const removeSession = (key: string, sessionId: string) => {
    if (!scoped(key)) return
    const previous = sessions.terminalSessions
    const index = previous.findIndex(session => session.session_id === sessionId)
    if (index < 0) return
    const remaining = previous.filter(session => session.session_id !== sessionId)
    const shouldSelectNext =
      sessions.activeTerminalSessionId === sessionId ||
      !remaining.some(session => session.session_id === sessions.activeTerminalSessionId)
    const next = remaining[Math.max(index - 1, 0)] ?? remaining[0] ?? null
    publishSessions({
      terminalSessions: remaining,
      activeTerminalSessionId: shouldSelectNext
        ? (next?.session_id ?? null)
        : sessions.activeTerminalSessionId,
    })
    if (context?.hideTerminalChrome && previous.length <= 1) context.onRequestClose?.()
  }
  return {
    getSessionsSnapshot: () => sessions,
    getToolsSnapshot: () => tools,
    subscribeSessions(listener: () => void) {
      sessionListeners.add(listener)
      return () => {
        sessionListeners.delete(listener)
        if (active()) return
        version += 1
        if (launch) launch.closeReason = 'workspace-panel-unmount'
        launch = null
        checkRequest = null
        sessions.terminalSessions.forEach(session =>
          closeSession(session, 'workspace-panel-unmount')
        )
        sessions = { ...sessions, terminalSessions: [], activeTerminalSessionId: null }
        tools = { ...tools, loadingTool: null }
        defaultOpenedKey = null
        context?.onMenuActionsChange?.(null)
        lastMenu = lastTitle = undefined
      }
    },
    subscribeTools(listener: () => void, next: WorkspacePanelCardsContext) {
      toolListeners.add(listener)
      if (context && context.projectKey !== next.projectKey) {
        version += 1
        if (launch) launch.closeReason = 'workspace-target-changed'
        launch = null
        sessions.terminalSessions.forEach(session =>
          closeSession(session, 'workspace-target-changed')
        )
        sessions = {
          projectKey: next.projectKey,
          terminalSessions: [],
          activeTerminalSessionId: null,
        }
        tools = {
          ...tools,
          projectKey: next.projectKey,
          loadingTool: null,
          error: null,
          availableTools: { terminal: true },
          localTerminalCheck:
            tools.localTerminalCheck.key === next.localTerminalCheckKey
              ? tools.localTerminalCheck
              : emptyCheck(),
        }
        defaultOpenedKey = null
        extensionAction = null
        sessionListeners.forEach(active => active())
      }
      if (context?.onMenuActionsChange && context.onMenuActionsChange !== next.onMenuActionsChange)
        context.onMenuActionsChange(null)
      context = next
      if (sessions.projectKey !== next.projectKey) publishSessions({ projectKey: next.projectKey })
      publishTools({ projectKey: next.projectKey })
      if (
        next.localTerminalSupported &&
        next.localTerminalRuntimeAvailable &&
        tools.localTerminalCheck.key !== next.localTerminalCheckKey
      )
        void readCheck(next)
      return () => {
        toolListeners.delete(listener)
      }
    },
    startTerminal,
    selectSession(key: string, sessionId: string) {
      if (
        scoped(key) &&
        sessions.terminalSessions.some(session => session.session_id === sessionId)
      )
        publishSessions({ activeTerminalSessionId: sessionId })
    },
    closeSession(key: string, sessionId: string) {
      if (!scoped(key)) return
      const session = sessions.terminalSessions.find(session => session.session_id === sessionId)
      if (session) closeSession(session, 'user-closed-session')
      removeSession(key, sessionId)
    },
    exited: removeSession,
    titleChanged(key: string, sessionId: string, title: string) {
      if (!scoped(key) || !title.trim()) return
      const normalized = title.trim()
      publishSessions({
        terminalSessions: sessions.terminalSessions.map(session =>
          session.session_id === sessionId && session.title !== normalized
            ? { ...session, title: normalized }
            : session
        ),
      })
    },
    extensionBusy(key: string, busy: boolean) {
      if (scoped(key))
        publishTools({
          loadingTool: busy
            ? 'extension'
            : tools.loadingTool === 'extension'
              ? null
              : tools.loadingTool,
        })
    },
    extensionError(key: string, error: string | null) {
      if (scoped(key)) publishTools({ error })
    },
    extensionOpened(key: string) {
      if (scoped(key)) context?.onRequestClose?.()
    },
    setExtensionAction(key: string, action: DeviceSurfaceLaunchAction | null) {
      if (scoped(key)) extensionAction = action
    },
  }
}
