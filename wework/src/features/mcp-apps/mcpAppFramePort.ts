import { AppBridge, type McpUiDisplayMode } from '@modelcontextprotocol/ext-apps/app-bridge'
import { dequal } from 'dequal'
import type { ToolBlock } from '@wegent/chat-core/runtime-conversation'
import type { McpAppResult, McpAppResource } from '@/api/mcpApps'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { requestEmbeddedBrowserOpen } from '@/lib/embedded-browser'
import { forwardVisualizationWheel } from '@/components/chat/inlineVisualizationScroll'
import { appDocumentOrigin, appDocumentTransport } from './transport'
import { appDisplayModes, appHostContext } from './hostContext'
import { openAppNavigation } from './appNavigation'
import { record, type AppDocument, type SessionAppDescriptor } from './mcpAppDocument'

interface FrameInput {
  document: AppDocument
  descriptor: SessionAppDescriptor
  block: ToolBlock
  mode: McpUiDisplayMode
  allowMessage: boolean
  allowContext: boolean
}
interface FrameHost {
  isLive(): boolean
  request<T>(sessionId: string, method: string, params?: Record<string, unknown>): Promise<T>
  sendMessage(text: string): Promise<void>
  updateModelContext(params: Record<string, unknown>, sessionId: string): Promise<void>
  displayMode(mode: McpUiDisplayMode): void
  resize(height: number): void
  initialized(documentId: string | undefined): void
  failure(reason: unknown): void
  close(): Promise<void>
}
const frameOwners = new WeakMap<HTMLIFrameElement, symbol>()

/** A real iframe owns one bridge, exact-origin transport, handshake and ordered tool delivery. */
export function createMcpAppFramePort(host: FrameHost, wheelToken: string) {
  const owner = Symbol('mcp-app-frame-owner')
  let element: HTMLIFrameElement | null = null
  let lease: symbol | null = null
  let input: FrameInput | null = null
  let protocol: ReturnType<typeof connect> | null = null
  const ownsFrame = () =>
    lease !== null &&
    element?.isConnected === true &&
    frameOwners.get(element) === owner &&
    host.isLive()
  function connect(frame: HTMLIFrameElement, initial: FrameInput) {
    let active = true
    let initialized = false
    let sentInput = false
    let sentResult: McpAppResult | undefined
    let teardownSent = false
    let syncRunning = false
    let syncVersion = 0
    let consumedSyncVersion = 0
    const current = () =>
      active &&
      ownsFrame() &&
      element === frame &&
      input?.document === initial.document &&
      input.descriptor === initial.descriptor
    const assertCurrent = () => {
      if (!current()) throw new Error('MCP App has been closed')
    }
    const app = new AppBridge(
      null,
      { name: 'Wework', version: '1.0.0' },
      {
        serverTools: {},
        serverResources: {},
        openLinks: {},
        downloadFile: {},
        logging: {},
        ...(initial.allowMessage ? { message: { text: {} } } : {}),
        ...(initial.allowContext
          ? { updateModelContext: { text: {}, structuredContent: {} } }
          : {}),
      },
      { hostContext: appHostContext(frame, initial.mode, initial.descriptor, initial.block.id) }
    )
    const request = async <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
      assertCurrent()
      const result = await host.request<T>(initial.descriptor.sessionId, method, params)
      assertCurrent()
      return result
    }
    app.oncalltool = params => request<McpAppResult>('tools/call', params)
    app.onreadresource = params => request<McpAppResource>('resources/read', params)
    app.onlistresources = params => request('resources/list', params)
    app.onlistresourcetemplates = params => request('resources/templates/list', params)
    app.onopenlink = async ({ url }) => {
      assertCurrent()
      if (url.startsWith('wework://')) return { isError: !openAppNavigation(url) }
      if (!['https:', 'http:'].includes(new URL(url).protocol)) return { isError: true }
      return { isError: !requestEmbeddedBrowserOpen(url) }
    }
    app.ondownloadfile = async ({ contents }) => {
      assertCurrent()
      for (const item of contents) {
        const resources =
          item.type === 'resource_link'
            ? (await request<McpAppResource>('resources/read', { uri: item.uri })).contents
            : [item.resource]
        for (const resource of resources) {
          assertCurrent()
          const bytes =
            'blob' in resource
              ? resource.blob
              : btoa(
                  Array.from(new TextEncoder().encode(resource.text), byte =>
                    String.fromCharCode(byte)
                  ).join('')
                )
          let name = 'download'
          try {
            name = decodeURIComponent(resource.uri.split('/').at(-1) || name)
          } catch {
            /* A malformed display name must not discard this or later resources. */
          }
          const result = await invokeDesktopHost<{ isError?: boolean }>('mcpApps.saveFile', {
            data: bytes,
            name,
          })
          assertCurrent()
          if (result.isError) return result
        }
      }
      return {}
    }
    app.onrequestdisplaymode = async ({ mode }) => {
      assertCurrent()
      if (!appDisplayModes(initial.descriptor).includes(mode)) return { mode: input!.mode }
      host.displayMode(mode)
      return { mode }
    }
    app.onmessage = async ({ content }) => {
      assertCurrent()
      await host.sendMessage(
        content
          .filter(item => item.type === 'text')
          .map(item => item.text)
          .join('\n')
      )
      assertCurrent()
      return {}
    }
    app.onupdatemodelcontext = async params => {
      assertCurrent()
      await host.updateModelContext(params, initial.descriptor.sessionId)
      assertCurrent()
      return {}
    }
    app.onsizechange = ({ height }) => {
      if (current() && height && Number.isFinite(height))
        host.resize(Math.max(120, Math.min(1200, height)))
    }
    app.onrequestteardown = () => {
      if (current()) void host.close()
    }
    app.onerror = error => {
      if (current()) host.failure(error)
    }
    async function synchronize() {
      if (!current() || !initialized || !input) return
      const { block, descriptor } = input
      if (!sentInput) {
        if (block.status === 'generating_arguments') {
          await app.sendToolInputPartial({ arguments: block.toolInput ?? {} })
          return
        }
        sentInput = true
        await app.sendToolInput({ arguments: block.toolInput ?? descriptor.arguments ?? {} })
        if (!current()) return
      }
      const output = block.toolOutput ?? descriptor.result
      const result = record(output)
      let payload: McpAppResult | undefined
      if (Array.isArray(result.content))
        payload = {
          ...result,
          content: result.content,
          isError: block.status === 'error' || result.isError === true,
        } as McpAppResult
      else if (block.status === 'error')
        payload = {
          content: [
            { type: 'text', text: typeof output === 'string' ? output : 'Tool call failed' },
          ],
          isError: true,
        }
      if (!payload || dequal(sentResult, payload)) return
      await app.sendToolResult(payload)
      if (current()) sentResult = payload
    }
    function sync() {
      syncVersion += 1
      drainToolData()
    }
    function drainToolData() {
      if (syncRunning || !current() || !initialized) return
      syncRunning = true
      void (async () => {
        while (current() && consumedSyncVersion !== syncVersion) {
          consumedSyncVersion = syncVersion
          await synchronize()
        }
      })()
        .catch(reason => {
          if (current()) host.failure(reason)
        })
        .finally(() => {
          syncRunning = false
          if (current() && initialized && consumedSyncVersion !== syncVersion) drainToolData()
        })
    }
    app.oninitialized = () => {
      if (!current()) return
      initialized = true
      host.initialized(initial.document.id)
      sync()
    }
    const origin = appDocumentOrigin(initial.document.url)
    void app
      .connect(appDocumentTransport(frame.contentWindow!, origin))
      .then(() => {
        // The exact-source transport is listening before the app document can initialize.
        if (current() && frame.src !== initial.document.url) frame.src = initial.document.url
      })
      .catch(reason => {
        if (current()) host.failure(reason)
      })
    const updateContext = () => {
      if (current() && input)
        app.setHostContext(appHostContext(frame, input.mode, initial.descriptor, initial.block.id))
    }
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateContext)
    resize?.observe(frame)
    const mutation =
      typeof MutationObserver === 'undefined' ? null : new MutationObserver(updateContext)
    mutation?.observe(window.document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme', 'data-appearance-theme'],
    })
    const teardown = async () => {
      if (teardownSent) return
      teardownSent = true
      await app.teardownResource({}, { timeout: 1000 }).catch(error => {
        console.info('[Wework] MCP App teardown did not acknowledge', { name: error.name })
      })
    }
    return {
      matches(next: FrameInput) {
        return (
          next.document === initial.document &&
          next.descriptor === initial.descriptor &&
          next.allowMessage === initial.allowMessage &&
          next.allowContext === initial.allowContext
        )
      },
      sync,
      updateContext,
      teardown,
      wheel(event: MessageEvent) {
        if (
          current() &&
          input?.mode === 'inline' &&
          event.source === frame.contentWindow &&
          event.origin === origin
        )
          forwardVisualizationWheel(frame, event.data, wheelToken)
      },
      dispose() {
        active = false
        initialized = false
        resize?.disconnect()
        mutation?.disconnect()
        // A new claimant may already be loading a different document into this WindowProxy.
        const close =
          teardownSent || frameOwners.get(frame) !== owner ? Promise.resolve() : teardown()
        void close.finally(() => app.close())
      },
    }
  }
  function reconcile() {
    if (protocol && (!input || !protocol.matches(input))) {
      protocol.dispose()
      protocol = null
      host.initialized(undefined)
    }
    if (!ownsFrame() || !element?.contentWindow || !input) return
    protocol ??= connect(element, input)
  }
  return {
    present(next: FrameInput | null) {
      const previous = input
      input = next
      reconcile()
      if (next && protocol) {
        if (!previous || previous.mode !== next.mode) protocol.updateContext()
        if (
          !previous ||
          previous.block.toolInput !== next.block.toolInput ||
          previous.block.toolOutput !== next.block.toolOutput ||
          previous.block.status !== next.block.status
        )
          protocol.sync()
      }
    },
    attach(frame: HTMLIFrameElement) {
      const binding = Symbol('mcp-app-frame-binding')
      element = frame
      lease = binding
      frameOwners.set(frame, owner)
      reconcile()
      return () => {
        if (lease !== binding) return
        lease = null
        queueMicrotask(() => {
          if (lease !== null) return
          protocol?.dispose()
          protocol = null
          if (frameOwners.get(frame) === owner) frameOwners.delete(frame)
          element = null
        })
      }
    },
    wheel(event: MessageEvent) {
      protocol?.wheel(event)
    },
    teardown: async () => {
      await protocol?.teardown()
    },
    dispose() {
      lease = null
      protocol?.dispose()
      protocol = null
      if (element && frameOwners.get(element) === owner) frameOwners.delete(element)
      element = null
    },
  }
}
