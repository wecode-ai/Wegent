import { Loader2, Square, SquareTerminal } from 'lucide-react'
import { useState } from 'react'
import { unwrapShellCommand } from '@/components/chat/blocks/toolBlockActivity'
import { useTranslation } from '@/hooks/useTranslation'
import type { BackgroundTerminal } from './backgroundTerminals'

export function BackgroundTerminalsSummary({
  terminals,
  onOpen,
  onStop,
}: {
  terminals: BackgroundTerminal[]
  onOpen: (terminal: BackgroundTerminal) => void
  onStop?: () => Promise<void>
}) {
  const { t } = useTranslation('common')
  const [stoppingId, setStoppingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (terminals.length === 0) return null

  const stop = async (id: string) => {
    if (!onStop || stoppingId) return
    setStoppingId(id)
    setError(null)
    try {
      await onStop()
    } catch {
      setError(t('workbench.background_terminals_stop_error'))
    } finally {
      setStoppingId(null)
    }
  }

  return (
    <section data-testid="environment-background-terminals-section">
      <h3 className="mb-1 flex items-center gap-2 text-sm font-medium text-text-primary">
        {t('workbench.background_processes')}
        <span className="text-text-muted">{terminals.length}</span>
      </h3>
      <div className="flex flex-col">
        {terminals.map(terminal => (
          <div
            key={terminal.id}
            className="group flex min-h-11 items-center rounded-md hover:bg-hover md:min-h-8"
          >
            <button
              type="button"
              data-testid={`open-background-terminal-${terminal.id}`}
              className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-1 text-left text-sm text-text-secondary hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 md:min-h-8"
              onClick={() => onOpen(terminal)}
              title={terminal.command || t('workbench.background_terminal')}
            >
              <SquareTerminal className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0 truncate">
                {unwrapShellCommand(terminal.command) || t('workbench.background_terminal')}
              </span>
            </button>
            {onStop && (
              <button
                type="button"
                data-testid={`stop-background-terminals-${terminal.id}`}
                aria-label={t('workbench.background_terminals_stop_all')}
                title={t('workbench.background_terminals_stop_all')}
                disabled={stoppingId !== null}
                onClick={() => void stop(terminal.id)}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-text-muted hover:text-text-primary focus-visible:opacity-100 focus-visible:outline-2 disabled:opacity-50 md:h-7 md:w-7 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
              >
                {stoppingId === terminal.id ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Square className="h-4 w-4" aria-hidden="true" />
                )}
              </button>
            )}
          </div>
        ))}
      </div>
      {error && (
        <p role="alert" className="mt-1 text-sm text-red-500">
          {error}
        </p>
      )}
    </section>
  )
}
