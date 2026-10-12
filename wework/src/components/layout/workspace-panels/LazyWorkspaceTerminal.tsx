import { lazy, Suspense, type ComponentProps } from 'react'
import { useTranslation } from '@/hooks/useTranslation'

const LocalTerminal = lazy(() =>
  import('./EmbeddedLocalTerminal').then(module => ({ default: module.EmbeddedLocalTerminal }))
)
const RemoteTerminalContent = lazy(() =>
  import('./RemoteTerminal').then(module => ({ default: module.RemoteTerminal }))
)

function TerminalLoading() {
  const { t } = useTranslation('common')
  return (
    <div
      role="status"
      className="flex h-full items-center justify-center text-sm text-text-secondary"
    >
      {t('common.loading')}
    </div>
  )
}

export function EmbeddedLocalTerminal(props: ComponentProps<typeof LocalTerminal>) {
  return (
    <Suspense fallback={<TerminalLoading />}>
      <LocalTerminal {...props} />
    </Suspense>
  )
}

export function RemoteTerminal(props: ComponentProps<typeof RemoteTerminalContent>) {
  return (
    <Suspense fallback={<TerminalLoading />}>
      <RemoteTerminalContent {...props} />
    </Suspense>
  )
}
