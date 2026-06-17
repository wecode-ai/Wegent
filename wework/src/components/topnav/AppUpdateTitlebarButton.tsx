import { Download, Loader2 } from 'lucide-react'
import { useAppUpdate } from '@/features/app-update/app-update-context'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'

export function AppUpdateTitlebarButton() {
  const { availableUpdate, status, installUpdate } = useAppUpdate()
  const { t } = useTranslation('common')

  if (!availableUpdate) return null

  const isInstalling = status === 'installing'

  return (
    <button
      type="button"
      data-testid="titlebar-app-update-button"
      disabled={isInstalling}
      onClick={() => {
        void installUpdate()
      }}
      className={cn(
        'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/10 px-2.5 text-[13px] font-medium leading-none text-primary transition-colors hover:bg-primary/15 disabled:cursor-not-allowed disabled:opacity-70'
      )}
    >
      {isInstalling ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Download className="h-3.5 w-3.5" />
      )}
      <span>
        {isInstalling
          ? t('workbench.app_update_installing_short', {
              defaultValue: '更新中',
            })
          : t('workbench.app_update_titlebar_button', {
              defaultValue: '更新',
            })}
      </span>
    </button>
  )
}
