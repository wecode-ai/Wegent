import { Loader2 } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'

export function DshSurfaceLoading({ testId }: { testId: string }) {
  const { t } = useTranslation('common')
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex h-full min-h-0 items-center justify-center gap-2 p-5 text-sm text-text-secondary"
      data-testid={testId}
    >
      <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />
      <span>{t('common.loading', '加载中...')}</span>
    </div>
  )
}
