import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { DshContributionSlotSurface } from '@/features/dsh-runtime/DshContributionSlotSurface'
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import { useTranslation } from '@/hooks/useTranslation'
import { focusComposerAtEnd, WORKBENCH_NEW_CHAT_FOCUS_EVENT } from '@/lib/workbenchComposerFocus'

interface DesktopEmptyTaskLauncherProps {
  projectName?: string | null
  onOpenProjectSelector: (anchorElement: HTMLButtonElement) => void
  onSelectSuggestion: (prompt: string) => void
  composer: ReactNode
  /** Defaults to the workbench empty-state composer input. */
  composerInputTestId?: string
}

export function DesktopEmptyTaskLauncher({
  projectName,
  onOpenProjectSelector,
  onSelectSuggestion,
  composer,
  composerInputTestId = 'chat-message-input',
}: DesktopEmptyTaskLauncherProps) {
  const { t } = useTranslation('common')
  const launcherRef = useRef<HTMLElement>(null)
  const composerInputSelector = `[data-testid="${composerInputTestId}"]`

  useEffect(() => {
    const focusComposer = () => {
      focusComposerAtEnd(launcherRef.current?.querySelector<HTMLElement>(composerInputSelector))
    }

    focusComposer()
    window.addEventListener(WORKBENCH_NEW_CHAT_FOCUS_EVENT, focusComposer)
    return () => window.removeEventListener(WORKBENCH_NEW_CHAT_FOCUS_EVENT, focusComposer)
  }, [composerInputSelector])

  const selectSuggestion = (prompt: string) => {
    onSelectSuggestion(prompt)
    window.requestAnimationFrame(() => {
      focusComposerAtEnd(launcherRef.current?.querySelector<HTMLElement>(composerInputSelector))
    })
  }

  const heading = useMemo(
    () => (
      <h1 className="max-w-full text-center text-xl font-normal leading-9 tracking-normal text-text-primary/95">
        {projectName ? (
          <>
            {t('workbench.project_empty_title_prefix', '我们应该在')}{' '}
            <button
              type="button"
              data-testid="empty-project-title-button"
              onClick={event => onOpenProjectSelector(event.currentTarget)}
              title={t('workbench.change_project', '更改项目')}
              className="max-w-[18rem] truncate align-bottom underline decoration-text-muted decoration-dotted underline-offset-4 transition-colors hover:text-text-secondary focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
            >
              {projectName}
            </button>{' '}
            {t('workbench.project_empty_title_suffix', '中做些什么？')}
          </>
        ) : (
          t('workbench.empty_title', '我们该做什么？')
        )}
      </h1>
    ),
    [onOpenProjectSelector, projectName, t]
  )

  return (
    <section
      ref={launcherRef}
      data-testid="desktop-empty-composer-frame"
      className="flex min-h-0 min-w-0 flex-1 flex-col px-6 pb-2 pt-8"
    >
      <div className="flex min-h-0 flex-1 items-center justify-center pb-8">
        <DshContributionSlotSurface
          attachedClassName="w-full"
          slot={WEWORK_DSH_SLOTS.home}
          props={{ heading, onSelectSuggestion: selectSuggestion }}
        />
      </div>
      <div
        data-testid="desktop-empty-composer-dock"
        className="mx-auto w-[min(46rem,calc(100%_-_2rem))] min-w-0 shrink-0"
      >
        {composer}
      </div>
    </section>
  )
}
