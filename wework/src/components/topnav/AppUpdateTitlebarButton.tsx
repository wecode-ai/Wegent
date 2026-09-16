import { getAppUpdateCopy } from '@/features/app-update/app-update-copy'
import { Download, Loader2 } from 'lucide-react'
import { useAppUpdate } from '@/features/app-update/app-update-context'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'

export function AppUpdateTitlebarButton() {
  const appUpdate = useAppUpdate()
  const { availableUpdate, status, installUpdate } = appUpdate
  const { t } = useTranslation('common')

  if (!availableUpdate) return null

  const isBusy = status === 'checking' || status === 'downloading' || status === 'installing'

  return (
    <button
      type="button"
      data-testid="titlebar-app-update-button"
      disabled={isBusy}
      onClick={() => {
        void installUpdate()
      }}
      className={cn(
        'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/10 px-2.5 text-sm font-medium leading-none text-primary transition-colors hover:bg-primary/15 disabled:cursor-not-allowed disabled:opacity-70'
      )}
    >
      {isBusy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Download className="h-3.5 w-3.5" />
      )}
      <span>{getAppUpdateCopy(appUpdate, t).action}</span>
    </button>
  )
}
