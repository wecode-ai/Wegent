import '@xterm/xterm/css/xterm.css'
import { useState } from 'react'
import { defaultAppearance, useOptionalAppearance } from '@/features/appearance'
import { createEmbeddedLocalTerminalPort } from './embeddedLocalTerminalPort'

interface EmbeddedLocalTerminalProps {
  sessionId: string
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

export function EmbeddedLocalTerminal({
  sessionId,
  active,
  taskId,
  workspacePath,
  cwd,
  title,
  onExit,
  onTitleChange,
  testIdsEnabled = true,
  showWorkbenchBackground = false,
}: EmbeddedLocalTerminalProps) {
  const appearance = useOptionalAppearance()?.appearance ?? defaultAppearance
  const [port] = useState(createEmbeddedLocalTerminalPort)
  const bindTerminal = (container: HTMLDivElement | null) => {
    if (!container) return
    return port.bind(container, {
      sessionId,
      active,
      taskId,
      workspacePath,
      cwd,
      title,
      onExit,
      onTitleChange,
      showWorkbenchBackground,
      fontFamily: appearance.codeFont,
      fontSize: appearance.codeFontSize,
    })
  }

  return (
    <div
      data-testid={testIdsEnabled ? 'embedded-local-terminal' : undefined}
      data-session-id={testIdsEnabled ? sessionId : undefined}
      className={`h-full min-h-0 w-full overflow-hidden px-2 pb-4 pt-2 ${
        showWorkbenchBackground ? 'bg-transparent' : 'bg-background'
      }`}
      hidden={!active}
    >
      <div ref={bindTerminal} className="h-full min-h-0 w-full overflow-hidden" />
    </div>
  )
}
