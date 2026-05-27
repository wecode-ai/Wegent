import { Globe, SquareTerminal } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export function WorkspacePanelCards() {
  const { t } = useTranslation('common')

  return (
    <div className="mx-auto grid w-full max-w-3xl grid-cols-2 gap-4">
      <button
        type="button"
        data-testid="workspace-browser-card"
        className="flex min-h-[132px] flex-col items-center justify-center rounded-lg bg-surface text-center hover:bg-muted"
      >
        <Globe className="mb-5 h-7 w-7 text-text-secondary" />
        <span className="text-base font-semibold text-text-primary">
          {t('workbench.browser', '浏览器')}
        </span>
        <span className="mt-2 text-sm text-text-secondary">
          {t('workbench.open_website', '打开网站')}
        </span>
      </button>
      <button
        type="button"
        data-testid="workspace-terminal-card"
        className="flex min-h-[132px] flex-col items-center justify-center rounded-lg bg-surface text-center hover:bg-muted"
      >
        <SquareTerminal className="mb-5 h-7 w-7 text-text-secondary" />
        <span className="text-base font-semibold text-text-primary">
          {t('workbench.terminal', '终端')}
        </span>
        <span className="mt-2 text-sm text-text-secondary">
          {t('workbench.start_shell', '启动交互式 shell')}
        </span>
      </button>
    </div>
  )
}
