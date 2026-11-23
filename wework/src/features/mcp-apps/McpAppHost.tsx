import { Button } from '@/components/ui/button'
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import type { McpUiDisplayMode } from '@modelcontextprotocol/ext-apps/app-bridge'
import { AlertCircle, Maximize2, Minimize2, RefreshCw, X } from 'lucide-react'
import type { RuntimeMcpAppsApi } from '@/api/mcpApps'
import type { ToolBlock } from '@wegent/chat-core/runtime-conversation'
import type { RuntimeTaskAddress } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import { useWindowEvent } from '@wegent/collaboration/dom-events'
import { appDisplayModes } from './hostContext'
import { record } from './mcpAppDocument'
import { createMcpAppState } from './mcpAppState'

type McpAppHostProps = {
  block: ToolBlock
  turnId?: string
  address: RuntimeTaskAddress
  api: RuntimeMcpAppsApi
  onMessage?: (text: string) => Promise<void>
  onContext?: (context: Record<string, unknown>, sessionId: string) => Promise<void>
  onDisplayModeChange?: (mode: McpUiDisplayMode, dismiss: () => void) => void
}

export function McpAppHost({
  block,
  turnId,
  address,
  api,
  onMessage,
  onContext,
  onDisplayModeChange,
}: McpAppHostProps) {
  const { t } = useTranslation('common')
  const [owner, setOwner] = useState(() => ({
    api,
    address,
    callId: block.id,
    turnId,
    resource: createMcpAppState(api, address, block.id, turnId),
  }))
  if (
    owner.api.requestMcpApp !== api.requestMcpApp ||
    owner.api.getMcpAppSessionTarget !== api.getMcpAppSessionTarget ||
    owner.callId !== block.id ||
    owner.turnId !== turnId ||
    owner.address.deviceId !== address.deviceId ||
    owner.address.taskId !== address.taskId ||
    Boolean(owner.address.projectSession) !== Boolean(address.projectSession) ||
    owner.address.projectSession?.projectId !== address.projectSession?.projectId ||
    owner.address.projectSession?.issueId !== address.projectSession?.issueId
  ) {
    setOwner({
      api,
      address,
      callId: block.id,
      turnId,
      resource: createMcpAppState(api, address, block.id, turnId),
    })
  }
  const resource = owner.resource
  const input = useMemo(
    () => ({ block, t, onMessage, onContext, onDisplayModeChange }),
    [block, t, onMessage, onContext, onDisplayModeChange]
  )
  const subscribe = useCallback(
    (listener: () => void) => resource.subscribe(listener, input),
    [resource, input]
  )
  const {
    descriptor,
    app,
    failure,
    closed,
    panelDismissed,
    closing,
    mode,
    height,
    document,
    initializedDocument,
  } = useSyncExternalStore(subscribe, resource.getSnapshot, resource.getSnapshot)
  const bindFrame = useCallback(
    (frame: HTMLIFrameElement | null) => {
      if (frame) return resource.bindFrame(frame)
    },
    [resource]
  )
  useWindowEvent('message', resource.wheel)
  if (!app) return null
  const availableModes = appDisplayModes(descriptor)
  const resultTitle = [block.toolOutput, descriptor?.result]
    .map(result => record(record(result).structuredContent).title)
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
  const title = resultTitle ?? app.tool?.title ?? app.server ?? t('mcp_apps.title')
  const metadata = record(descriptor?.resource.contents[0]?._meta)
  const prefersBorder =
    (record(metadata.ui).prefersBorder ?? metadata['openai/widgetPrefersBorder']) !== false
  const discoveryFailed = !descriptor && Boolean(failure)
  return (
    <section
      data-testid="mcp-app"
      data-mcp-call-id={block.id}
      data-display-mode={mode}
      className={
        discoveryFailed
          ? 'my-1 min-w-0 text-sm font-normal text-text-muted'
          : mode === 'fullscreen' && !closed && !panelDismissed
            ? 'flex h-full min-h-0 flex-1 flex-col bg-background text-text-primary'
            : mode === 'pip' && !closed
              ? 'fixed bottom-4 right-4 z-critical w-96 overflow-hidden rounded-xl border border-border bg-background text-text-primary shadow-lg'
              : `my-2 overflow-hidden bg-background text-text-primary ${prefersBorder ? 'rounded-lg shadow-sm outline-1 -outline-offset-1 outline-border' : ''}`
      }
    >
      {(mode !== 'fullscreen' || closed || panelDismissed || failure || !document) && (
        <div
          className={
            discoveryFailed
              ? 'flex min-h-7 items-start gap-1.5'
              : 'flex h-9 items-center gap-2 border-b border-border px-3'
          }
        >
          {discoveryFailed && <AlertCircle className="mt-1.5 size-4 shrink-0" aria-hidden="true" />}
          <span
            className={
              discoveryFailed
                ? 'min-w-0 flex-1 py-1 leading-5 [overflow-wrap:anywhere]'
                : 'min-w-0 flex-1 truncate text-sm'
            }
          >
            {discoveryFailed ? (
              <span role="alert">
                {title} · {failure}
              </span>
            ) : (
              title
            )}
          </span>
          {failure && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-text-secondary"
              data-testid="mcp-app-retry"
              title={t('mcp_apps.retry')}
              aria-label={t('mcp_apps.retry')}
              onClick={resource.retry}
            >
              <RefreshCw className="size-4" />
            </Button>
          )}
          {!discoveryFailed && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-text-secondary"
              data-testid="mcp-app-expand"
              disabled={!closed && !panelDismissed && availableModes.length < 2}
              title={t('mcp_apps.expand')}
              aria-label={t('mcp_apps.expand')}
              onClick={resource.expand}
            >
              {mode === 'fullscreen' && !panelDismissed && !closed ? (
                <Minimize2 className="size-4" />
              ) : (
                <Maximize2 className="size-4" />
              )}
            </Button>
          )}
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
                void resource.close()
              }}
            >
              <X className="size-4" />
            </Button>
          )}
        </div>
      )}
      {failure && !discoveryFailed && (
        <p role="alert" className="p-3 text-sm text-text-secondary">
          {failure}
        </p>
      )}
      {!closed && descriptor && (
        <iframe
          ref={bindFrame}
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
