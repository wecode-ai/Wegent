import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef } from 'react'
import { unwrapShellCommand } from '@/components/chat/blocks/toolBlockActivity'
import { defaultAppearance, useOptionalAppearance } from '@/features/appearance'
import { useTranslation } from '@/hooks/useTranslation'
import { applyTerminalTheme, getTerminalTheme, observeTerminalTheme } from '@/lib/xterm-theme'
import type { BackgroundTerminal } from '../backgroundTerminals'
import { createXtermWebLinksAddon } from './xtermLinks'
import { observeTerminalDiagnostics, traceTerminal } from '@/e2e/terminal-diagnostics'

export function BackgroundTerminalPanel({
  terminal,
  active,
}: {
  terminal?: BackgroundTerminal
  active: boolean
}) {
  const { t } = useTranslation('common')
  const appearance = useOptionalAppearance()?.appearance ?? defaultAppearance
  const containerRef = useRef<HTMLDivElement>(null)
  const resourceRef = useRef<{ terminal: Terminal; fit: FitAddon; output: string } | null>(null)
  const output = typeof terminal?.block.toolOutput === 'string' ? terminal.block.toolOutput : ''
  const hasOutput = output.length > 0

  useEffect(() => {
    const container = containerRef.current
    if (!container || !hasOutput) return
    const xterm = new Terminal({
      disableStdin: true,
      screenReaderMode: true,
      cursorBlink: false,
      cursorInactiveStyle: 'none',
      convertEol: true,
      fontFamily: appearance.codeFont,
      fontSize: appearance.codeFontSize,
      lineHeight: 1.2,
      theme: getTerminalTheme(),
      scrollback: 5000,
    })
    const fit = new FitAddon()
    xterm.loadAddon(fit)
    xterm.loadAddon(createXtermWebLinksAddon())
    xterm.open(container)
    const disposeDiagnostics = observeTerminalDiagnostics(xterm)
    const disposeTheme = observeTerminalTheme(theme => applyTerminalTheme(xterm, container, theme))
    resourceRef.current = { terminal: xterm, fit, output: '' }
    const observer = new ResizeObserver(() => {
      if (container.clientWidth > 0 && container.clientHeight > 0) fit.fit()
    })
    observer.observe(container)
    return () => {
      observer.disconnect()
      disposeTheme()
      resourceRef.current = null
      disposeDiagnostics()
      xterm.dispose()
    }
  }, [hasOutput, terminal?.id, appearance.codeFont, appearance.codeFontSize])

  useEffect(() => {
    const resource = resourceRef.current
    if (!resource) return
    if (output.startsWith(resource.output)) {
      const delta = output.slice(resource.output.length)
      if (delta.length > 0) {
        traceTerminal(resource.terminal, 'append', {
          oldLength: resource.output.length,
          nextLength: output.length,
        })
        resource.terminal.write(delta)
      }
    } else {
      traceTerminal(resource.terminal, 'reset', {
        oldLength: resource.output.length,
        nextLength: output.length,
      })
      resource.terminal.reset()
      resource.terminal.write(output)
    }
    resource.output = output
    if (active && containerRef.current?.clientWidth) resource.fit.fit()
  }, [output, active, terminal?.id, appearance.codeFont, appearance.codeFontSize])

  return (
    <section
      data-testid="background-terminal-output-panel"
      className="relative h-full min-h-0 flex-1 bg-background"
    >
      <div
        ref={containerRef}
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
