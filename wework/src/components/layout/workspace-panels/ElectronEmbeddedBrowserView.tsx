import { useCallback, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useWindowEvent } from '@wegent/collaboration/dom-events'
import { type EmbeddedBrowserAgentCursorEvent } from '@/lib/embedded-browser'
import { BrowserAgentCursorIcon } from './BrowserAgentCursorIcon'
import { createElectronEmbeddedBrowserViewPort } from './electronEmbeddedBrowserViewPort'
import { createBrowserAgentCursorPort, CURSOR_FADE_MS } from './browserAgentCursorPort'

interface BrowserVisualRect {
  x: number
  y: number
  width: number
  height: number
}

interface ElectronEmbeddedBrowserViewProps {
  active: boolean
  interactionBlocked: boolean
  label: string
  transferFromLabel?: string
  visualRect: BrowserVisualRect | null
  cursor?: EmbeddedBrowserAgentCursorEvent | null
  cursorScale?: number
}

export function ElectronEmbeddedBrowserView({
  active,
  interactionBlocked,
  label,
  transferFromLabel,
  visualRect,
  cursor = null,
  cursorScale = 1,
}: ElectronEmbeddedBrowserViewProps) {
  const [port] = useState(createElectronEmbeddedBrowserViewPort)
  const cursorOverlayHost = useSyncExternalStore(port.subscribe, port.getSnapshot)
  const bindPlaceholder = (element: HTMLDivElement | null) => {
    if (!element) return
    return port.bind(element, { active, interactionBlocked, label, transferFromLabel })
  }
  useWindowEvent('resize', port.measure)
  useWindowEvent('scroll', port.measure, { capture: true })
  return (
    <>
      <div
        ref={bindPlaceholder}
        data-testid="workspace-browser-electron-webview-placeholder"
        className="pointer-events-none absolute overflow-hidden bg-background"
        style={{
          left: visualRect?.x ?? 0,
          top: visualRect?.y ?? 0,
          width: visualRect?.width ?? '100%',
          height: visualRect?.height ?? '100%',
        }}
      />
      {cursorOverlayHost
        ? createPortal(
            <BrowserAgentCursorOverlay
              cursor={cursor}
              label={label}
              scale={cursorScale}
              ownsView={port.getOwnership}
            />,
            cursorOverlayHost
          )
        : null}
    </>
  )
}

function BrowserAgentCursorOverlay({
  cursor,
  label,
  scale,
  ownsView,
}: {
  cursor: EmbeddedBrowserAgentCursorEvent | null
  label: string
  scale: number
  ownsView: () => symbol | null
}) {
  const [port] = useState(createBrowserAgentCursorPort)
  const bindCursor = useCallback(
    (element: HTMLDivElement | null) => {
      if (!element) return
      return port.bind(element, cursor, label, scale, ownsView)
    },
    [port, cursor, label, scale, ownsView]
  )
  return (
    <div
      ref={bindCursor}
      data-testid="workspace-browser-agent-cursor"
      data-visible="false"
      className="absolute left-0 top-0 h-6 w-6"
      style={{
        filter:
          'drop-shadow(0 0 6px rgb(59 130 246 / 90%)) drop-shadow(0 0 15px rgb(59 130 246 / 48%))',
        opacity: 0,
        transform: 'translate3d(-3px, -3px, 0)',
        transition: `opacity ${CURSOR_FADE_MS}ms ease`,
        willChange: 'transform, opacity',
      }}
    >
      <div className="h-6 w-6" style={{ willChange: 'transform' }}>
        <BrowserAgentCursorIcon className="h-6 w-6" />
      </div>
    </div>
  )
}
