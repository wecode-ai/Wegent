import '@xterm/xterm/css/xterm.css'
import { useCallback, useMemo, useState } from 'react'
import { unwrapShellCommand } from '@/components/chat/blocks/toolBlockActivity'
import { defaultAppearance, useOptionalAppearance } from '@/features/appearance'
import { useTranslation } from '@/hooks/useTranslation'
import type { BackgroundTerminal } from '../backgroundTerminals'
import { createBackgroundTerminalBinding } from './backgroundTerminalView'

export function BackgroundTerminalPanel({
  terminal,
  active,
}: {
  terminal?: BackgroundTerminal
  active: boolean
}) {
  const { t } = useTranslation('common')
  const appearance = useOptionalAppearance()?.appearance ?? defaultAppearance
  const output = typeof terminal?.block.toolOutput === 'string' ? terminal.block.toolOutput : ''
  const terminalId = terminal?.id
  const scopeKey = JSON.stringify([terminal?.tabId, terminalId])
  const hasOutput = output.length > 0
  const [binding] = useState(createBackgroundTerminalBinding)
  const viewportRef = useMemo(
    () => (node: HTMLElement | null) => {
      if (node)
        binding.updateViewport(node, {
          scopeKey,
          terminalId,
          output,
          active,
          fontFamily: appearance.codeFont,
          fontSize: appearance.codeFontSize,
        })
    },
    [binding, scopeKey, terminalId, output, active, appearance.codeFont, appearance.codeFontSize]
  )
  const containerRef = useCallback((node: HTMLDivElement | null) => binding.attach(node), [binding])
  return (
    <section
      ref={viewportRef}
      data-testid="background-terminal-output-panel"
      className="relative h-full min-h-0 flex-1 bg-background"
    >
      <div
        ref={containerRef}
        data-testid="background-terminal-xterm"
        className="h-full min-h-0 w-full overflow-hidden py-3 pl-3"
        role="region"
        aria-label={
          unwrapShellCommand(terminal?.command ?? '') || t('workbench.background_terminal')
        }
      />
      {!hasOutput && (
        <p className="absolute left-4 top-4 text-code text-text-muted">
          {t('workbench.background_terminal_no_output')}
        </p>
      )}
    </section>
  )
}
