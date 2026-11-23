import '@xterm/xterm/css/xterm.css'
import { useCallback, useMemo, useRef, useState } from 'react'
import { useElementGeometry } from '@wegent/collaboration/dom-events'
import type { RemoteTerminalClientFactory } from '@/lib/remote-terminal-socket'
import { defaultAppearance, useOptionalAppearance } from '@/features/appearance'
import { useTranslation } from '@/hooks/useTranslation'
import { createRemoteTerminalWidget } from './remoteTerminalWidget'

interface RemoteTerminalProps {
  sessionId: string
  clientFactory: RemoteTerminalClientFactory
  active: boolean
  taskId?: string | null
  workspacePath?: string | null
  cwd?: string | null
  title?: string | null
  onExit?: () => void
  onTitleChange?: (title: string) => void
  testIdsEnabled?: boolean
  showWorkbenchBackground?: boolean
}

export function RemoteTerminal({
  sessionId,
  clientFactory,
  active,
  taskId,
  workspacePath,
  cwd,
  title,
  onExit,
  onTitleChange,
  testIdsEnabled = true,
  showWorkbenchBackground = false,
}: RemoteTerminalProps) {
  const { t } = useTranslation()
  const appearance = useOptionalAppearance()?.appearance ?? defaultAppearance
  const containerRef = useRef<HTMLDivElement | null>(null)
  const targets = useMemo(() => [containerRef], [])
  const geometry = useElementGeometry(targets)
  const [widget] = useState(createRemoteTerminalWidget)
  const attachTerminal = useCallback(
    (container: HTMLDivElement | null) => {
      containerRef.current = container
      if (!container) return
      const release = widget.attach(
        container,
        { sessionId, clientFactory, showWorkbenchBackground },
        {
          active,
          appearance,
          t,
          taskId,
          workspacePath,
          cwd,
          title,
          onExit,
          onTitleChange,
          geometry,
        }
      )
      return () => {
        containerRef.current = null
        release()
      }
    },
    [
      widget,
      sessionId,
      clientFactory,
      showWorkbenchBackground,
      active,
      appearance,
      t,
      taskId,
      workspacePath,
      cwd,
      title,
      onExit,
      onTitleChange,
      geometry,
    ]
  )

  return (
    <div
      data-testid={testIdsEnabled ? 'remote-terminal' : undefined}
      className={`h-full min-h-0 w-full flex-1 overflow-hidden px-2 pb-4 pt-2 ${
        showWorkbenchBackground ? 'bg-transparent' : 'bg-background'
      }`}
      hidden={!active}
    >
      <div ref={attachTerminal} className="h-full min-h-0 w-full overflow-hidden" />
    </div>
  )
}
