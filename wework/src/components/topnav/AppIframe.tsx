import { ElectronEmbeddedBrowserView } from '@/components/layout/workspace-panels/ElectronEmbeddedBrowserView'
import { isDesktopRuntime, isElectronRuntime } from '@/lib/runtime-environment'
import { useElementGeometry } from '@wegent/collaboration/dom-events'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { Loader2 } from 'lucide-react'
import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react'
import { createAppIframeResource } from './appIframeResource'

interface AppIframeProps {
  active?: boolean
  appKey: string
  edgeToEdge?: boolean
  embeddedBrowserLabel?: string
  onReady?: () => void
  src: string
  title: string
  waitForContent?: boolean
  workspaceTabId?: string
}

const APP_IFRAME_SANDBOX = [
  'allow-scripts',
  'allow-same-origin',
  'allow-forms',
  'allow-popups',
  'allow-popups-to-escape-sandbox',
].join(' ')

function nativeLabel(appKey: string, workspaceTabId?: string) {
  return `app-${appKey}-${workspaceTabId ?? 'default'}`
}

export function AppIframe({
  active = true,
  appKey,
  edgeToEdge = false,
  embeddedBrowserLabel,
  onReady,
  src,
  title,
  waitForContent = false,
  workspaceTabId,
}: AppIframeProps) {
  const native = isDesktopRuntime()
  const electron = isElectronRuntime()
  const hostRef = useRef<HTMLDivElement>(null)
  const label = embeddedBrowserLabel ?? nativeLabel(appKey, workspaceTabId)
  const source = useMemo(() => createAppIframeResource(native, label), [label, native])
  const bindViewport = useCallback(
    (element: HTMLDivElement | null) => {
      hostRef.current = element
      return source.bindViewport(element)
    },
    [source]
  )
  const geometry = useElementGeometry([hostRef], native)
  const viewport = geometry?.elements[0]
  const bounds = useMemo(
    () =>
      viewport && viewport.width >= 1 && viewport.height >= 1
        ? { x: viewport.left, y: viewport.top, width: viewport.width, height: viewport.height }
        : null,
    [viewport]
  )
  const subscribe = useCallback(
    (notify: () => void) =>
      source.subscribe(notify, {
        src,
        active,
        waitForContent,
        bounds,
        onReady,
      }),
    [source, src, active, waitForContent, bounds, onReady]
  )
  const snapshot = useSyncExternalStore(subscribe, source.getSnapshot)
  const bindFrame = useCallback(
    (frame: HTMLIFrameElement | null) =>
      source.bindFrame(frame, src, snapshot.retryVersion, onReady),
    [source, src, snapshot.retryVersion, onReady]
  )
  const loading = snapshot.src !== src || snapshot.loading
  const error = snapshot.src === src && snapshot.error

  return (
    <div
      ref={bindViewport}
      className={
        edgeToEdge
          ? 'relative h-full overflow-hidden bg-background'
          : 'app-view-surface relative h-full overflow-hidden rounded-t-xl border-x-0 border-b-0 border-t border-border/60 bg-background'
      }
      data-testid={`app-iframe-${appKey}`}
      data-embedded-browser-label={label}
      data-workspace-tab-id={workspaceTabId}
      data-src={src}
    >
      {electron && (
        <ElectronEmbeddedBrowserView
          active={active}
          interactionBlocked={false}
          label={label}
          visualRect={null}
        />
      )}
      {loading && !error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-surface">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          <span className="text-sm text-text-secondary">Loading {title}...</span>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-surface">
          <span className="text-sm text-text-secondary">Failed to load {title}</span>
          <ControlButton
            variant="unstyled"
            type="button"
            onClick={source.retry}
            className="text-sm text-primary hover:underline"
            data-testid={`app-webview-retry-${title.toLowerCase()}`}
          >
            Retry
          </ControlButton>
        </div>
      )}
      {!native && (
        <iframe
          key={`${src}:${snapshot.retryVersion}`}
          ref={bindFrame}
          src={src}
          title={title}
          className="w-full h-full border-none"
          onLoad={event => source.webLoaded(event.currentTarget)}
          onError={event => source.webFailed(event.currentTarget)}
          sandbox={APP_IFRAME_SANDBOX}
        />
      )}
    </div>
  )
}
