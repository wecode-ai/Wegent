import { dequal } from 'dequal'
import type { TFunction } from 'i18next'
import type { McpUiDisplayMode } from '@modelcontextprotocol/ext-apps/app-bridge'
import type { ToolBlock } from '@wegent/chat-core/runtime-conversation'
import type {
  McpAppDiscovery,
  McpAppDescriptor,
  McpAppRequest,
  RuntimeMcpAppsApi,
} from '@/api/mcpApps'
import type { RuntimeTaskAddress } from '@/types/api'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { getDesktopWindowLabel } from '@/lib/runtime-environment'
import { withVisualizationWheel } from '@/components/chat/inlineVisualizationScroll'
import { legacyWidgetDocument } from './legacyBridge'
import { appDisplayModes, appInitialDisplayMode } from './hostContext'
import {
  createAppDocument,
  record,
  type AppDocument,
  type SessionAppDescriptor,
} from './mcpAppDocument'
import { createMcpAppFramePort } from './mcpAppFramePort'

export interface McpAppHostInput {
  block: ToolBlock
  t: TFunction<'common'>
  onMessage?: (text: string) => Promise<void>
  onContext?: (context: Record<string, unknown>, sessionId: string) => Promise<void>
  onDisplayModeChange?: (mode: McpUiDisplayMode, dismiss: () => void) => void
}
interface AppSnapshot {
  descriptor: SessionAppDescriptor | undefined
  app: McpAppDiscovery | undefined
  failure: string | undefined
  closed: boolean
  panelDismissed: boolean
  closing: boolean
  mode: McpUiDisplayMode
  height: number
  document: AppDocument | undefined
  initializedDocument: string | undefined
}
interface Observer {
  listener(): void
  input: McpAppHostInput
}
interface SessionLease {
  id: string
  active: boolean
  settled: boolean
  released: boolean
}

/** A conversation/call scope owns discovery, its retained session and one generated document. */
export function createMcpAppState(
  api: RuntimeMcpAppsApi,
  address: RuntimeTaskAddress,
  callId: string,
  turnId?: string
) {
  const wheelToken = crypto.randomUUID()
  const observers = new Set<Observer>()
  let input: McpAppHostInput | undefined
  let state: AppSnapshot = {
    descriptor: undefined,
    app: undefined,
    failure: undefined,
    closed: false,
    panelDismissed: false,
    closing: false,
    mode: 'inline',
    height: 400,
    document: undefined,
    initializedDocument: undefined,
  }
  let generation = 0
  let discovered = false
  let discoveryPending = false
  let discoveryVersion = 0
  let attemptedDiscovery: unknown
  let session: SessionLease | undefined
  const live = () => observers.size > 0
  const current = (owner: number) => live() && owner === generation
  function reportDisplay(observer: Observer) {
    if (observers.has(observer))
      observer.input.onDisplayModeChange?.(
        state.closed || state.panelDismissed ? 'inline' : state.mode,
        dismissPanel
      )
  }
  function publish(change: Partial<AppSnapshot>) {
    const previous = state
    if (
      Object.entries(change).every(([key, value]) => previous[key as keyof AppSnapshot] === value)
    )
      return
    state = { ...state, ...change }
    refreshFrame()
    for (const observer of [...observers]) {
      if (!observers.has(observer)) continue
      observer.listener()
      if (
        previous.mode !== state.mode ||
        previous.closed !== state.closed ||
        previous.panelDismissed !== state.panelDismissed ||
        previous.descriptor !== state.descriptor
      )
        reportDisplay(observer)
    }
  }
  function failure(reason: unknown) {
    if (live()) publish({ failure: reason instanceof Error ? reason.message : String(reason) })
  }
  async function retainSession(sessionId: string) {
    await invokeDesktopHost('mcpApps.retainSession', {
      address,
      callId,
      turnId,
      sessionId,
      windowLabel: getDesktopWindowLabel(),
      target: api.getMcpAppSessionTarget?.(address),
    })
  }
  async function request<T>(data: Partial<McpAppRequest>, valid: () => boolean): Promise<T> {
    if (!valid()) throw new Error('MCP App has been closed')
    if (data.sessionId) await retainSession(data.sessionId)
    if (!valid()) throw new Error('MCP App has been closed')
    const result = await api.requestMcpApp<T>({ ...data, address, callId, turnId })
    if (!valid()) throw new Error('MCP App has been closed')
    return result
  }
  const frame = createMcpAppFramePort(
    {
      isLive: live,
      request: <T>(sessionId: string, method: string, params?: Record<string, unknown>) => {
        const owner = generation
        return request<T>(
          { sessionId, method, params },
          () => current(owner) && session?.id === sessionId && session.active
        )
      },
      sendMessage: async text => {
        const send = input?.onMessage
        if (!send) throw new Error('Conversation messaging is unavailable')
        await send(text)
      },
      updateModelContext: async (params, sessionId) => {
        const owner = generation
        await retainSession(sessionId)
        if (!current(owner) || session?.id !== sessionId || !session.active)
          throw new Error('MCP App has been closed')
        const update = input?.onContext
        if (!update) throw new Error('Model context updates are unavailable')
        await update(params, sessionId)
      },
      displayMode(mode) {
        if (live()) publish({ panelDismissed: false, mode })
      },
      resize(height) {
        if (live()) publish({ height })
      },
      initialized(initializedDocument) {
        if (live()) publish({ initializedDocument })
      },
      failure,
      close: closeApp,
    },
    wheelToken
  )
  function refreshFrame() {
    frame.present(
      state.document && state.descriptor && !state.closed && input
        ? {
            document: state.document,
            descriptor: state.descriptor,
            block: input.block,
            mode: state.mode,
            allowMessage: input.onMessage !== undefined,
            allowContext: input.onContext !== undefined,
          }
        : null
    )
  }
  function releaseSession(lease: SessionLease) {
    lease.active = false
    if (!lease.settled || lease.released) return
    lease.released = true
    void invokeDesktopHost('mcpApps.releaseSession', { sessionId: lease.id }).catch(error => {
      lease.released = false
      console.info('[Wework] MCP App session release failed', { name: error.name })
    })
  }
  function releaseDocument(document: AppDocument | undefined) {
    if (document)
      void document
        .release()
        .catch(error =>
          console.info('[Wework] MCP App document release failed', { name: error.name })
        )
  }
  async function loadDocument(descriptor: SessionAppDescriptor, valid: () => boolean) {
    const content = descriptor.resource.contents.find(item =>
      ['text/html;profile=mcp-app', 'text/html+skybridge', 'text/html'].includes(
        item.mimeType ?? ''
      )
    )
    if (!content) throw new Error(input!.t('mcp_apps.unsupported_resource'))
    const html =
      'text' in content
        ? content.text
        : new TextDecoder().decode(Uint8Array.from(atob(content.blob), char => char.charCodeAt(0)))
    const initialMode = appInitialDisplayMode(descriptor)
    if (!initialMode) throw new Error(input!.t('mcp_apps.unsupported_display_mode'))
    const created = await createAppDocument(
      withVisualizationWheel(
        content.mimeType === 'text/html+skybridge' ? legacyWidgetDocument(html) : html,
        wheelToken
      ),
      record(content._meta),
      descriptor.sessionId
    )
    if (!valid()) {
      await created.release()
      return
    }
    publish({ document: created, mode: initialMode })
  }
  function initialize() {
    if (!live() || !state.app || state.closed || session) return
    const owner = generation
    const lease: SessionLease = {
      id: crypto.randomUUID(),
      active: true,
      settled: false,
      released: false,
    }
    session = lease
    const valid = () => current(owner) && lease.active && session === lease && !state.closed
    void request<McpAppDescriptor>({ method: 'initialize', sessionId: lease.id }, valid)
      .then(async value => {
        if (!valid()) return
        const descriptor = { ...value, sessionId: lease.id }
        publish({ descriptor })
        if (valid()) await loadDocument(descriptor, valid)
      })
      .catch(reason => {
        if (valid()) failure(reason)
      })
      .finally(() => {
        lease.settled = true
        if (!lease.active) releaseSession(lease)
      })
  }
  const discoveryInput = () => ({
    address,
    turnId,
    callId,
    status: input?.block.status,
    output: input?.block.toolOutput,
  })
  function discover() {
    if (!live() || !input || discovered || discoveryPending || state.closed) return
    const attempted = discoveryInput()
    if (dequal(attemptedDiscovery, attempted)) return
    attemptedDiscovery = attempted
    const version = ++discoveryVersion
    const owner = generation
    const valid = () => current(owner) && version === discoveryVersion
    discoveryPending = true
    void request<McpAppDiscovery | null>({ method: 'discover' }, valid)
      .then(value => {
        if (!valid()) return
        discovered = Boolean(value)
        publish({ app: value ?? undefined })
        if (value) initialize()
      })
      .catch(reason => {
        if (!valid()) return
        console.warn(
          '[Wework] Executor transport diagnostic ' +
            JSON.stringify({
              stage: 'mcp_app_discovery_failed',
              callId,
              taskId: address.taskId,
              errorType: reason instanceof Error ? reason.name : typeof reason,
              code: record(reason).code,
              requestedStatus: attempted.status,
              currentStatus: input?.block.status,
            })
        )
      })
      .finally(() => {
        if (!valid()) return
        discoveryPending = false
        if (!discovered && !dequal(attempted, discoveryInput())) discover()
      })
  }
  function stop() {
    generation += 1
    discoveryVersion += 1
    discoveryPending = false
    attemptedDiscovery = undefined
    frame.dispose()
    releaseDocument(state.document)
    if (session) releaseSession(session)
    session = undefined
    state = {
      ...state,
      descriptor: undefined,
      document: undefined,
      initializedDocument: undefined,
      closing: false,
    }
  }
  function reset() {
    stop()
    discovered = false
    publish({
      app: undefined,
      descriptor: undefined,
      document: undefined,
      initializedDocument: undefined,
      failure: undefined,
    })
  }
  function dismissPanel() {
    if (!live()) return
    if (appDisplayModes(state.descriptor).includes('inline')) publish({ mode: 'inline' })
    else publish({ panelDismissed: true })
  }
  async function closeApp() {
    if (!live() || state.closing) return
    const owner = generation
    const document = state.document
    publish({ closing: true })
    try {
      await frame.teardown()
      if (!current(owner)) return
      await document?.release()
      if (!current(owner)) return
      publish({
        failure: undefined,
        closed: true,
        document: undefined,
        initializedDocument: undefined,
      })
      if (session) releaseSession(session)
      session = undefined
    } catch (reason) {
      if (current(owner)) failure(reason)
    } finally {
      if (current(owner)) publish({ closing: false })
    }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void, next: McpAppHostInput) {
      // Same-version reentry is a fresh observation (StrictMode/Offscreen), not metadata takeover.
      if (observers.size === 0 && input === next && discoveryPending && !discovered) {
        discoveryVersion += 1
        discoveryPending = false
        attemptedDiscovery = undefined
      }
      input = next
      const observer = { listener, input: next }
      observers.add(observer)
      refreshFrame()
      reportDisplay(observer)
      discover()
      initialize()
      return () => {
        observers.delete(observer)
        queueMicrotask(() => {
          if (observers.size === 0) stop()
        })
      }
    },
    bindFrame: frame.attach,
    wheel: frame.wheel,
    close: closeApp,
    retry() {
      if (live()) {
        reset()
        discover()
      }
    },
    expand() {
      if (!live()) return
      const availableModes = appDisplayModes(state.descriptor)
      const mode =
        state.mode === 'fullscreen'
          ? (availableModes.find(mode => mode !== state.mode) ?? state.mode)
          : availableModes.includes('fullscreen')
            ? 'fullscreen'
            : (availableModes.find(mode => mode !== state.mode) ?? state.mode)
      if (state.closed) reset()
      publish({ closed: false, panelDismissed: false, mode })
      discover()
      initialize()
    },
  }
}
