import { Blocks, ChevronRight, Globe, ListChecks, Paperclip, Plus, Target } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

export function DesktopContextMenu() {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(false)

  return (
    <div className="relative">
      {open && (
        <div
          data-testid="add-context-menu"
          className="absolute bottom-[52px] left-0 z-40 w-80 overflow-hidden rounded-2xl border border-border bg-base p-2 shadow-[0_16px_44px_rgba(0,0,0,0.16)]"
        >
          <button
            type="button"
            data-testid="attach-files-button"
            className="flex h-12 w-full items-center gap-3 rounded-xl px-4 text-left text-base font-semibold text-text-primary hover:bg-muted"
          >
            <Paperclip className="h-5 w-5 shrink-0 text-text-secondary" />
            <span>{t('workbench.add_photos_files', '添加照片和文件')}</span>
          </button>
          <button
            type="button"
            data-testid="attach-chrome-button"
            className="flex h-12 w-full items-center gap-3 rounded-xl px-4 text-left text-base font-semibold text-text-primary hover:bg-muted"
          >
            <Globe className="h-5 w-5 shrink-0 text-text-secondary" />
            <span>{t('workbench.attach_chrome', 'Attach Google Chrome')}</span>
          </button>
          <div className="mx-3 my-2 border-t border-border" />
          <button
            type="button"
            data-testid="plan-mode-button"
            className="flex h-12 w-full items-center gap-3 rounded-xl px-4 text-left text-base font-semibold text-text-primary hover:bg-muted"
          >
            <ListChecks className="h-5 w-5 shrink-0 text-text-secondary" />
            <span className="min-w-0 flex-1">{t('workbench.plan_mode', '计划模式')}</span>
            <span className="relative h-7 w-12 shrink-0 rounded-full bg-border">
              <span className="absolute left-1 top-1 h-5 w-5 rounded-full bg-base shadow-sm" />
            </span>
          </button>
          <button
            type="button"
            data-testid="pursue-goal-button"
            className="flex h-12 w-full items-center gap-3 rounded-xl px-4 text-left text-base font-semibold text-text-primary hover:bg-muted"
          >
            <Target className="h-5 w-5 shrink-0 text-text-secondary" />
            <span className="min-w-0 flex-1">{t('workbench.pursue_goal', '追求目标')}</span>
            <span className="relative h-7 w-12 shrink-0 rounded-full bg-border">
              <span className="absolute left-1 top-1 h-5 w-5 rounded-full bg-base shadow-sm" />
            </span>
          </button>
          <div className="mx-3 my-2 border-t border-border" />
          <button
            type="button"
            data-testid="context-plugins-button"
            className="flex h-12 w-full items-center gap-3 rounded-xl px-4 text-left text-base font-semibold text-text-primary hover:bg-muted"
          >
            <Blocks className="h-5 w-5 shrink-0 text-text-secondary" />
            <span className="min-w-0 flex-1">{t('workbench.plugins', '插件')}</span>
            <ChevronRight className="h-5 w-5 shrink-0 text-text-muted" />
          </button>
        </div>
      )}
      <button
        type="button"
        data-testid="add-context-button"
        onClick={() => setOpen(current => !current)}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full p-0 text-text-secondary hover:bg-muted"
        aria-expanded={open}
        aria-label={t('workbench.add_context', '添加上下文')}
      >
        <Plus className="h-6 w-6" />
      </button>
    </div>
  )
}
