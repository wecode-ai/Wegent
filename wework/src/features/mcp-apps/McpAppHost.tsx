import { Button } from '@/components/ui/button'
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react'
import { AppBridge, type McpUiDisplayMode } from '@modelcontextprotocol/ext-apps/app-bridge'
import { Maximize2, Minimize2, RefreshCw, X } from 'lucide-react'
import { dequal } from 'dequal'
import type {
  McpAppDescriptor,
  McpAppDiscovery,
  McpAppRequest,
  McpAppResult,
  McpAppResource,
  RuntimeMcpAppsApi,
} from '@/api/mcpApps'
import { getDesktopWindowLabel } from '@/lib/runtime-environment'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import type { ToolBlock } from '@wegent/chat-core/runtime-conversation'
import type { RuntimeTaskAddress } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import { appDocumentOrigin, appDocumentTransport } from './transport'
import { legacyWidgetDocument } from './legacyBridge'
import { appDisplayModes, appHostContext, appInitialDisplayMode } from './hostContext'
import { requestEmbeddedBrowserOpen } from '@/lib/embedded-browser'

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

interface AppDocument {
  id: string
  url: string
  release: () => Promise<void>
}

type SessionAppDescriptor = McpAppDescriptor & { sessionId: string }

async function createAppDocument(
  html: string,
  metadata: Record<string, unknown>,
  sessionId: string
): Promise<AppDocument> {
  const document = await invokeDesktopHost<{ id: string; url: string }>('mcpApps.createDocument', {
    html,
    metadata,
    sessionId,
  })
  let released: Promise<void> | undefined
  return {
    ...document,
    release: () =>
      (released ??= invokeDesktopHost<void>('mcpApps.releaseDocument', { id: document.id }).catch(
        error => {
          released = undefined
          throw error
        }
      )),
  }
}

export function McpAppHost({
  block,
  address,
  api,
  onMessage,
  onContext,
  onDisplayModeChange,
}: {
  block: ToolBlock
  address: RuntimeTaskAddress
  api: RuntimeMcpAppsApi
  onMessage?: (text: string) => Promise<void>
  onContext?: (context: Record<string, unknown>, sessionId: string) => Promise<void>
  onDisplayModeChange?: (mode: McpUiDisplayMode, dismiss: () => void) => void
}) {
  const { t } = useTranslation('common')
  const [descriptor, setDescriptor] = useState<SessionAppDescriptor>()
  const [app, setApp] = useState<McpAppDiscovery>()
  const [failure, setFailure] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  const [closed, setClosed] = useState(false)
  const [panelDismissed, setPanelDismissed] = useState(false)
  const [closing, setClosing] = useState(false)
  const [mode, setMode] = useState<McpUiDisplayMode>('inline')
  const [height, setHeight] = useState(400)
  const frame = useRef<HTMLIFrameElement>(null)
  const [document, setDocument] = useState<AppDocument>()
  const [initializedDocument, setInitializedDocument] = useState<string>()
  const bridge = useRef<AppBridge>(null)
  const teardownSent = useRef(false)
  const initialized = useRef(false)
  const sentResult = useRef<McpAppResult>(undefined)
  const sentInput = useRef(false)
  const latest = useEffectEvent(() => ({ block, onMessage, onContext, mode }))
  const retainSession = useEffectEvent((sessionId: string) =>
    invokeDesktopHost('mcpApps.retainSession', {
      address,
      callId: block.id,
      sessionId,
      windowLabel: getDesktopWindowLabel(),
      target: api.getMcpAppSessionTarget?.(address),
    })
  )
  const requestApp = useEffectEvent(async (data: Partial<McpAppRequest>) => {
    if (data.sessionId) await retainSession(data.sessionId)
    return api.requestMcpApp({ ...data, address, callId: block.id })
  })
  const hasMessage = onMessage !== undefined
  const hasContext = onContext !== undefined
  const closeApp = useCallback(async () => {
    setClosing(true)
    const app = bridge.current
    if (app && !teardownSent.current) {
      teardownSent.current = true
      await app.teardownResource({}, { timeout: 1000 }).catch(error => {
        console.info('[Wework] MCP App teardown did not acknowledge', { name: error.name })
      })
    }
    try {
      await document?.release()
      setFailure(undefined)
      setClosed(true)
      setDocument(undefined)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setClosing(false)
    }
  }, [document])

  const dismissPanel = useCallback(() => {
    if (appDisplayModes(descriptor).includes('inline')) setMode('inline')
    else setPanelDismissed(true)
  }, [descriptor])
  useLayoutEffect(() => {
    onDisplayModeChange?.(closed || panelDismissed ? 'inline' : mode, dismissPanel)
  }, [closed, panelDismissed, mode, onDisplayModeChange, dismissPanel])

  const discovered = useRef(false)
  const discoveryPending = useRef(false)
  const discoveryEpoch = useRef(0)
  useEffect(
    () => () => {
      discoveryEpoch.current++
      discoveryPending.current = false
    },
    []
  )
  useEffect(() => {
    if (discovered.current || discoveryPending.current) return
    const epoch = discoveryEpoch.current
    const status = block.status
    discoveryPending.current = true
    void requestApp({ method: 'discover' })
      .then(value => {
        if (epoch !== discoveryEpoch.current) return
        if (value) discovered.current = true
        setApp((value as McpAppDiscovery | null) ?? undefined)
      })
      .catch(error => {
        if (epoch === discoveryEpoch.current) {
          console.warn(
            '[Wework] Executor transport diagnostic ' +
              JSON.stringify({
                stage: 'mcp_app_discovery_failed',
                callId: block.id,
                taskId: address.taskId,
                errorType: error instanceof Error ? error.name : typeof error,
                code: record(error).code,
                requestedStatus: status,
                currentStatus: latest().block.status,
              })
          )
          // An unavailable discovery transport does not establish that an app exists.
        }
      })
      .finally(() => {
        if (epoch !== discoveryEpoch.current) return
        discoveryPending.current = false
        // Schedule after clearing pending so the next effect cannot lose this transition.
        if (!discovered.current && status !== latest().block.status) setAttempt(value => value + 1)
      })
  }, [address.deviceId, address.taskId, block.id, block.status, block.toolOutput, attempt])

  useEffect(() => {
    if (!app || closed) return
    let active = true
    let settled = false
    const sessionId = crypto.randomUUID()
    const release = () =>
      void invokeDesktopHost('mcpApps.releaseSession', { sessionId }).catch(error => {
        console.info('[Wework] MCP App session release failed', { name: error.name })
      })
    void requestApp({ method: 'initialize', sessionId })
      .then(value => {
        if (active) setDescriptor({ ...(value as McpAppDescriptor), sessionId })
      })
      .catch(error => {
        if (active) setFailure(String(error.message ?? error))
      })
      .finally(() => {
        settled = true
        if (!active) release()
      })
    return () => {
      active = false
      if (settled) release()
    }
  }, [app, closed])

  useEffect(() => {
    if (!descriptor || closed) return
    let active = true
    let created: AppDocument | undefined
    const load = async () => {
      const content = descriptor.resource.contents.find(item =>
        ['text/html;profile=mcp-app', 'text/html+skybridge', 'text/html'].includes(
          item.mimeType ?? ''
        )
      )
      if (!content) throw new Error(t('mcp_apps.unsupported_resource'))
      const html =
        'text' in content
          ? content.text
          : new TextDecoder().decode(
              Uint8Array.from(atob(content.blob), char => char.charCodeAt(0))
            )
      const metadata = record(content._meta)
      const initialMode = appInitialDisplayMode(descriptor)
      if (!initialMode) throw new Error(t('mcp_apps.unsupported_display_mode'))
      created = await createAppDocument(
        content.mimeType === 'text/html+skybridge' ? legacyWidgetDocument(html) : html,
        metadata,
        descriptor.sessionId
      )
      if (!active) {
        await created.release()
        return
      }
      setMode(initialMode)
      setDocument(created)
    }
    void load().catch(error => {
      if (active) setFailure(String(error.message ?? error))
    })
    return () => {
      active = false
      if (created)
        void created.release().catch(error => {
          console.info('[Wework] MCP App document release failed', { name: error.name })
        })
    }
  }, [descriptor, closed, t])

  const synchronizeToolData = useEffectEvent(async () => {
    const app = bridge.current
    if (!initialized.current || !app) return
    if (!sentInput.current) {
      if (block.status === 'generating_arguments') {
        await app.sendToolInputPartial({ arguments: block.toolInput ?? {} })
        return
      }
      sentInput.current = true
      await app.sendToolInput({ arguments: block.toolInput ?? descriptor?.arguments ?? {} })
    }
    const output = block.toolOutput ?? descriptor?.result
    const result = record(output)
    let payload: McpAppResult | undefined
    if (Array.isArray(result.content)) {
      payload = {
        ...result,
        content: result.content,
        isError: block.status === 'error' || result.isError === true,
      } as McpAppResult
    } else if (block.status === 'error') {
      payload = {
        content: [{ type: 'text', text: typeof output === 'string' ? output : 'Tool call failed' }],
        isError: true,
      }
    }
    if (!payload || dequal(sentResult.current, payload)) return
    await app.sendToolResult(payload)
    sentResult.current = payload
  })

  useEffect(() => {
    if (!document || !descriptor || !frame.current?.contentWindow) return
    let active = true
    const app = new AppBridge(
      null,
      { name: 'Wework', version: '1.0.0' },
      {
        serverTools: {},
        serverResources: {},
        openLinks: {},
        downloadFile: {},
        logging: {},
        ...(hasMessage ? { message: { text: {} } } : {}),
        ...(hasContext ? { updateModelContext: { text: {}, structuredContent: {} } } : {}),
      },
      {
        hostContext: appHostContext(frame.current, latest().mode, descriptor, block.id),
      }
    )
    bridge.current = app
    teardownSent.current = false
    const request = <T,>(method: string, params?: Record<string, unknown>) => {
      if (!active) throw new Error('MCP App has been closed')
      return requestApp({ method, params, sessionId: descriptor.sessionId }) as Promise<T>
    }
    app.oncalltool = params => request<McpAppResult>('tools/call', params)
    app.onreadresource = params => request<McpAppResource>('resources/read', params)
    app.onlistresources = params => request('resources/list', params)
    app.onlistresourcetemplates = params => request('resources/templates/list', params)
    app.onopenlink = async ({ url }) => {
      if (!['https:', 'http:'].includes(new URL(url).protocol)) return { isError: true }
      return { isError: !requestEmbeddedBrowserOpen(url) }
    }
    app.ondownloadfile = async ({ contents }) => {
      for (const item of contents) {
        const resources =
          item.type === 'resource_link'
            ? (await request<McpAppResource>('resources/read', { uri: item.uri })).contents
            : [item.resource]
        for (const resource of resources) {
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
            // A malformed display name must not discard this or later resources.
          }
          const result = await invokeDesktopHost<{ isError?: boolean }>('mcpApps.saveFile', {
            data: bytes,
            name,
          })
          if (result.isError) return result
        }
      }
      return {}
    }
    app.onrequestdisplaymode = async ({ mode }) => {
      if (!appDisplayModes(descriptor).includes(mode)) return { mode: latest().mode }
      setPanelDismissed(false)
      setMode(mode)
      return { mode }
    }
    app.onmessage = async ({ content }) => {
      const send = latest().onMessage
      if (!send) throw new Error('Conversation messaging is unavailable')
      await send(
        content
          .filter(item => item.type === 'text')
          .map(item => item.text)
          .join('\n')
      )
      return {}
    }
    app.onupdatemodelcontext = async params => {
      if (descriptor) await retainSession(descriptor.sessionId)
      const update = latest().onContext
      if (!update) throw new Error('Model context updates are unavailable')
      await update(params, descriptor.sessionId)
      return {}
    }
    app.onsizechange = ({ height }) => {
      if (height && Number.isFinite(height)) setHeight(Math.max(120, Math.min(1200, height)))
    }
    app.onrequestteardown = () => {
      void closeApp()
    }
    app.oninitialized = () => {
      if (!active) return
      setInitializedDocument(document.id)
      initialized.current = true
      void synchronizeToolData().catch(error => {
        if (active) setFailure(error.message)
      })
    }
    app.onerror = error => {
      if (active) setFailure(error.message)
    }
    const element = frame.current
    void app
      .connect(appDocumentTransport(element.contentWindow!, appDocumentOrigin(document.url)))
      .then(() => {
        // Listen before loading a document that can initialize immediately.
        if (active && element.src !== document.url) element.src = document.url
      })
      .catch(error => {
        if (active) setFailure(error.message)
      })
    const updateContext = () =>
      app.setHostContext(appHostContext(element, latest().mode, descriptor, block.id))
    const resize = new ResizeObserver(updateContext)
    resize.observe(element)
    const observer = new MutationObserver(updateContext)
    observer.observe(window.document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    })
    return () => {
      active = false
      initialized.current = false
      sentInput.current = false
      sentResult.current = undefined
      observer.disconnect()
      resize.disconnect()
      bridge.current = null
      if (teardownSent.current) void app.close()
      else
        void app
          .teardownResource({}, { timeout: 1000 })
          .catch(() => {})
          .finally(() => app.close())
    }
  }, [document, descriptor, block.id, t, hasMessage, hasContext, closeApp])

  useEffect(() => {
    void synchronizeToolData().catch(error => setFailure(error.message))
  }, [block.toolInput, block.toolOutput, block.status])

  useEffect(() => {
    if (bridge.current && frame.current && descriptor)
      bridge.current.setHostContext(appHostContext(frame.current, mode, descriptor, block.id))
  }, [mode, descriptor, block.id])

  if (!app) return null
  const availableModes = appDisplayModes(descriptor)
  const title = app.tool?.title ?? app.server ?? t('mcp_apps.title')
  const metadata = record(descriptor?.resource.contents[0]?._meta)
  const prefersBorder =
    (record(metadata.ui).prefersBorder ?? metadata['openai/widgetPrefersBorder']) !== false
  return (
    <section
      data-testid="mcp-app"
      data-mcp-call-id={block.id}
      data-display-mode={mode}
      className={
        mode === 'fullscreen' && !closed && !panelDismissed
          ? 'flex h-full min-h-0 flex-1 flex-col bg-background text-text-primary'
          : mode === 'pip' && !closed
            ? 'fixed bottom-4 right-4 z-critical w-96 overflow-hidden rounded-xl border border-border bg-background text-text-primary shadow-lg'
            : `my-2 overflow-hidden bg-background text-text-primary ${prefersBorder ? 'rounded-lg shadow-sm outline-1 -outline-offset-1 outline-border' : ''}`
      }
    >
      {(mode !== 'fullscreen' || closed || panelDismissed || failure || !document) && (
        <div className="flex h-9 items-center gap-2 border-b border-border px-3">
          <span className="min-w-0 flex-1 truncate text-sm">{title}</span>
          {failure && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-text-secondary"
              data-testid="mcp-app-retry"
              title={t('mcp_apps.retry')}
              aria-label={t('mcp_apps.retry')}
              onClick={() => {
                discovered.current = false
                setApp(undefined)
                setDescriptor(undefined)
                setFailure(undefined)
                setDocument(undefined)
                setAttempt(value => value + 1)
              }}
            >
              <RefreshCw className="size-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-text-secondary"
            data-testid="mcp-app-expand"
            disabled={!closed && !panelDismissed && availableModes.length < 2}
            title={t('mcp_apps.expand')}
            aria-label={t('mcp_apps.expand')}
            onClick={() => {
              if (closed) {
                discovered.current = false
                setApp(undefined)
                setDescriptor(undefined)
                setFailure(undefined)
                setAttempt(value => value + 1)
              }
              setClosed(false)
              setPanelDismissed(false)
              setMode(value =>
                value === 'fullscreen'
                  ? (availableModes.find(mode => mode !== value) ?? value)
                  : availableModes.includes('fullscreen')
                    ? 'fullscreen'
                    : (availableModes.find(mode => mode !== value) ?? value)
              )
            }}
          >
            {mode === 'fullscreen' && !panelDismissed && !closed ? (
              <Minimize2 className="size-4" />
            ) : (
              <Maximize2 className="size-4" />
            )}
          </Button>
          {!closed && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-text-secondary"
              data-testid="mcp-app-close"
              title={t('mcp_apps.close')}
              aria-label={t('mcp_apps.close')}
              disabled={closing}
              onClick={() => {
                void closeApp()
              }}
            >
              <X className="size-4" />
            </Button>
          )}
        </div>
      )}
      {failure && (
        <p role="alert" className="p-3 text-sm text-text-secondary">
          {failure}
        </p>
      )}
      {!closed && descriptor && (
        <iframe
          ref={frame}
          hidden={panelDismissed}
          data-testid="mcp-app-frame"
          data-ready={document && initializedDocument === document.id ? 'true' : undefined}
          title={title}
          sandbox="allow-scripts allow-same-origin allow-forms"
          referrerPolicy="no-referrer"
          className="w-full min-w-0 flex-1 border-0"
          style={{ height: mode === 'fullscreen' ? undefined : height }}
          src="about:blank"
        />
      )}
    </section>
  )
}
