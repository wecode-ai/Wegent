import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react'
import { AppBridge, type McpUiDisplayMode } from '@modelcontextprotocol/ext-apps/app-bridge'
import { Maximize2, Minimize2, RefreshCw, X } from 'lucide-react'
import type {
  McpAppDescriptor,
  McpAppRequest,
  McpAppResult,
  McpAppResource,
  McpAppTool,
  RuntimeMcpAppsApi,
} from '@/api/mcpApps'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import type { ToolBlock } from '@wegent/chat-core/runtime-conversation'
import type { RuntimeTaskAddress } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import { appDocumentTransport } from './transport'
import { legacyWidgetDocument } from './legacyBridge'
import { appDisplayModes, appHostContext } from './hostContext'
import { requestEmbeddedBrowserOpen } from '@/lib/embedded-browser'

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
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
  onContext?: (context: Record<string, unknown>) => Promise<void>
  onDisplayModeChange?: (mode: McpUiDisplayMode) => void
}) {
  const { t } = useTranslation('common')
  const [descriptor, setDescriptor] = useState<McpAppDescriptor | null>()
  const [failure, setFailure] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  const [closed, setClosed] = useState(false)
  const [closing, setClosing] = useState(false)
  const [mode, setMode] = useState<McpUiDisplayMode>('inline')
  const [height, setHeight] = useState(400)
  const frame = useRef<HTMLIFrameElement>(null)
  const [document, setDocument] = useState<{ id: string; url: string }>()
  const [initializedDocument, setInitializedDocument] = useState<string>()
  const bridge = useRef<AppBridge>(null)
  const teardownSent = useRef(false)
  const initialized = useRef(false)
  const sentResult = useRef<unknown>(undefined)
  const sentInput = useRef(false)
  const latest = useEffectEvent(() => ({ block, onMessage, onContext, mode }))
  const requestApp = useEffectEvent((data: Partial<McpAppRequest>) =>
    api.requestMcpApp({ ...data, address, callId: block.id })
  )
  const hasMessage = onMessage !== undefined
  const hasContext = onContext !== undefined
  useLayoutEffect(() => {
    onDisplayModeChange?.(closed ? 'inline' : mode)
  }, [closed, mode, onDisplayModeChange])
  const closeApp = useCallback(async () => {
    const app = bridge.current
    if (app && !teardownSent.current) {
      teardownSent.current = true
      setClosing(true)
      await app.teardownResource({}, { timeout: 1000 }).catch(error => {
        console.info('[Wework] MCP App teardown did not acknowledge', { name: error.name })
      })
    }
    setClosed(true)
    setClosing(false)
    setDocument(undefined)
  }, [])

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
    void requestApp({})
      .then(value => {
        if (epoch !== discoveryEpoch.current) return
        if (value) discovered.current = true
        setDescriptor(value as McpAppDescriptor | null)
        // A call can finish while discovery is pending; inspect the completed result once.
        if (!value && status !== latest().block.status) setAttempt(value => value + 1)
      })
      .catch(error => {
        if (epoch === discoveryEpoch.current) {
          discovered.current = true
          setFailure(String(error.message ?? error))
        }
      })
      .finally(() => {
        if (epoch === discoveryEpoch.current) discoveryPending.current = false
      })
  }, [address.deviceId, address.taskId, block.id, block.status, block.toolOutput, attempt])

  useEffect(() => {
    if (!descriptor || closed) return
    let active = true
    let created: { id: string; url: string } | undefined
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
      const modes = appDisplayModes(descriptor)
      if (!modes.length) throw new Error(t('mcp_apps.unsupported_display_mode'))
      created = await invokeDesktopHost<{ id: string; url: string }>('mcpApps.createDocument', {
        html: content.mimeType === 'text/html+skybridge' ? legacyWidgetDocument(html) : html,
        metadata,
      })
      if (!active) {
        await invokeDesktopHost('mcpApps.releaseDocument', { id: created.id })
        return
      }
      const preferred =
        descriptor.preferredDisplayMode ?? record(metadata['openai/ui']).preferredDisplayMode
      setMode(
        modes.find(mode => mode === preferred) ?? (modes.includes('inline') ? 'inline' : modes[0])
      )
      setDocument(created)
    }
    void load().catch(error => {
      if (active) setFailure(String(error.message ?? error))
    })
    const heartbeat = window.setInterval(() => {
      if (created)
        void Promise.all([
          requestApp({ method: 'ping' }),
          invokeDesktopHost('mcpApps.renewDocument', { id: created.id }),
        ]).catch(error => {
          if (active) setFailure(String(error.message ?? error))
        })
    }, 30000)
    return () => {
      active = false
      window.clearInterval(heartbeat)
      if (created) void invokeDesktopHost('mcpApps.releaseDocument', { id: created.id })
      void requestApp({ method: 'release' }).catch(() => {})
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
    if (sentResult.current === output) return
    const result = record(output)
    if (Array.isArray(result.content)) {
      await app.sendToolResult({
        ...result,
        content: result.content,
        isError: block.status === 'error' || result.isError === true,
      } as McpAppResult)
      sentResult.current = output
    } else if (block.status === 'error') {
      await app.sendToolResult({
        content: [{ type: 'text', text: typeof output === 'string' ? output : 'Tool call failed' }],
        isError: true,
      })
      sentResult.current = output
    }
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
    const request = <T,>(method: string, params?: Record<string, unknown>, approved?: boolean) => {
      if (!active) throw new Error('MCP App has been closed')
      return requestApp({ method, params, approved }) as Promise<T>
    }
    const listTools = () => request<{ tools: McpAppTool[] }>('tools/list')
    app.oncalltool = async params => {
      const tool = (await listTools()).tools.find(tool => tool.name === params.name)
      if (!tool) throw new Error('Tool is not available to this app')
      let approved = false
      if (tool.annotations?.readOnlyHint !== true || tool.annotations?.destructiveHint === true) {
        const confirmation = await invokeDesktopHost<{ response: number }>('dialog.message', {
          type: 'question',
          title: t('mcp_apps.approval_title'),
          message: t('mcp_apps.approval_message', { server: descriptor.server, tool: tool.name }),
          detail: JSON.stringify(params.arguments ?? {}, null, 2),
          buttons: [t('mcp_apps.cancel'), t('mcp_apps.allow')],
          defaultId: 0,
          cancelId: 0,
        })
        if (confirmation.response !== 1) throw new Error('User declined the MCP App tool call')
        approved = true
      }
      return request<McpAppResult>('tools/call', params, approved)
    }
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
          const result = await invokeDesktopHost<{ isError?: boolean }>('mcpApps.saveFile', {
            data: bytes,
            name: decodeURIComponent(resource.uri.split('/').at(-1) || 'download'),
          })
          if (result.isError) return result
        }
      }
      return {}
    }
    app.onrequestdisplaymode = async ({ mode }) => {
      if (!appDisplayModes(descriptor).includes(mode)) return { mode: latest().mode }
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
      const update = latest().onContext
      if (!update) throw new Error('Model context updates are unavailable')
      await update(params)
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
    void app
      .connect(appDocumentTransport(frame.current.contentWindow, new URL(document.url).origin))
      .catch(error => {
        if (active) setFailure(error.message)
      })
    const element = frame.current
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

  if (descriptor === null && !failure) return null
  if (descriptor === undefined && !failure) return null
  const availableModes = appDisplayModes(descriptor)
  const title = descriptor?.tool?.title ?? descriptor?.server ?? t('mcp_apps.title')
  return (
    <section
      data-testid="mcp-app"
      data-mcp-call-id={block.id}
      data-display-mode={mode}
      className={
        mode === 'fullscreen' && !closed
          ? 'fixed inset-0 z-critical flex flex-col bg-background text-text-primary'
          : mode === 'pip' && !closed
            ? 'fixed bottom-4 right-4 z-critical w-96 overflow-hidden rounded-xl border border-border bg-background text-text-primary shadow-lg'
            : 'my-2 overflow-hidden rounded-xl border border-border bg-background text-text-primary'
      }
    >
      <div className="flex h-9 items-center gap-2 border-b border-border px-3">
        <span className="min-w-0 flex-1 truncate text-sm">{title}</span>
        {failure && (
          <button
            data-testid="mcp-app-retry"
            title={t('mcp_apps.retry')}
            aria-label={t('mcp_apps.retry')}
            onClick={() => {
              discovered.current = false
              setDescriptor(undefined)
              setFailure(undefined)
              setDocument(undefined)
              setAttempt(value => value + 1)
            }}
          >
            <RefreshCw className="size-4" />
          </button>
        )}
        <button
          data-testid="mcp-app-expand"
          disabled={!closed && availableModes.length < 2}
          title={t('mcp_apps.expand')}
          aria-label={t('mcp_apps.expand')}
          onClick={() => {
            if (closed) {
              discovered.current = false
              setDescriptor(undefined)
              setFailure(undefined)
              setAttempt(value => value + 1)
            }
            setClosed(false)
            setMode(value =>
              value === 'fullscreen'
                ? (availableModes.find(mode => mode !== value) ?? value)
                : availableModes.includes('fullscreen')
                  ? 'fullscreen'
                  : (availableModes.find(mode => mode !== value) ?? value)
            )
          }}
        >
          {mode === 'fullscreen' ? (
            <Minimize2 className="size-4" />
          ) : (
            <Maximize2 className="size-4" />
          )}
        </button>
        {!closed && (
          <button
            data-testid="mcp-app-close"
            title={t('mcp_apps.close')}
            aria-label={t('mcp_apps.close')}
            disabled={closing}
            onClick={() => {
              void closeApp()
            }}
          >
            <X className="size-4" />
          </button>
        )}
      </div>
      {failure && (
        <p role="alert" className="p-3 text-sm text-text-secondary">
          {failure}
        </p>
      )}
      {!closed && descriptor && (
        <iframe
          ref={frame}
          data-testid="mcp-app-frame"
          data-ready={document && initializedDocument === document.id ? 'true' : undefined}
          title={title}
          sandbox="allow-scripts allow-same-origin allow-forms"
          referrerPolicy="no-referrer"
          className="w-full min-w-0 flex-1 border-0"
          style={{ height: mode === 'fullscreen' ? undefined : height }}
          src={document?.url ?? 'about:blank'}
        />
      )}
    </section>
  )
}
