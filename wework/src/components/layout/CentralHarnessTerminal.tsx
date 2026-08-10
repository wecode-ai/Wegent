import { SquareTerminal, X } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { isMeaningfulLocalHarnessTitle, type LocalHarnessId } from '@/lib/local-harness'
import { EmbeddedLocalTerminal } from './workspace-panels/EmbeddedLocalTerminal'

interface CentralHarnessTerminalProps {
  sessionId: string
  harnessId: LocalHarnessId
  title: string
  cwd: string
  active: boolean
  showHeader?: boolean
  onClose?: () => void
  onTitleChange?: (title: string) => void
  onExit: () => void
}

export function CentralHarnessTerminal({
  sessionId,
  harnessId,
  title,
  cwd,
  active,
  showHeader = true,
  onClose,
  onTitleChange,
  onExit,
}: CentralHarnessTerminalProps) {
  const { t } = useTranslation('common')

  return (
    <section
      data-testid="central-harness-terminal"
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-background"
    >
      {showHeader && (
        <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3">
          <SquareTerminal className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
            {title}
          </span>
          {onClose && (
            <button
              type="button"
              data-testid="central-harness-close-button"
              onClick={onClose}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-secondary hover:bg-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
              aria-label={t('workbench.close_harness', '关闭运行工具')}
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </header>
      )}
      <div className="min-h-0 flex-1">
        <EmbeddedLocalTerminal
          sessionId={sessionId}
          active={active}
          cwd={cwd}
          title={title}
          onTitleChange={generatedTitle => {
            if (isMeaningfulLocalHarnessTitle(harnessId, generatedTitle)) {
              onTitleChange?.(generatedTitle)
            }
          }}
          onExit={onExit}
          testIdsEnabled
        />
      </div>
    </section>
  )
}
