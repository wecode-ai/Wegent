import { Component, lazy, Suspense, useState, type ComponentType, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { captureError } from '@/telemetry/client'

export interface CollaborationExpAppProps {
  active?: boolean
  search?: string
}

type CollaborationExpModule = { default: ComponentType<CollaborationExpAppProps> }
type CollaborationExpLoader = () => Promise<CollaborationExpModule>

const loadCollaborationExpApp: CollaborationExpLoader = () => import('./CollaborationExpApp')

class CollaborationExpErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: Error) {
    console.error('[Wework] Collaboration experiment failed', error)
    captureError(error)
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

function CollaborationExpFailure({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation('common')
  return (
    <section
      className="flex h-full min-h-0 items-center justify-center bg-background p-5 text-text-primary"
      data-testid="collaboration-exp-error"
      role="alert"
    >
      <div className="max-w-md space-y-4">
        <h1 className="heading-small">{t('workbench.collaboration_exp_error_title')}</h1>
        <p className="text-base text-text-secondary">
          {t('workbench.collaboration_exp_error_description')}
        </p>
        <Button type="button" data-testid="collaboration-exp-retry" onClick={onRetry}>
          {t('workbench.collaboration_exp_retry')}
        </Button>
      </div>
    </section>
  )
}

export function CollaborationExpRoute({
  active = true,
  search = '',
  loadApp = loadCollaborationExpApp,
}: CollaborationExpAppProps & { loadApp?: CollaborationExpLoader }) {
  const { t } = useTranslation('common')
  const [attempt, setAttempt] = useState(() => ({ revision: 0, App: lazy(loadApp) }))
  const App = attempt.App
  const retry = () => {
    setAttempt(current => ({ revision: current.revision + 1, App: lazy(loadApp) }))
  }

  return (
    <CollaborationExpErrorBoundary
      key={attempt.revision}
      fallback={<CollaborationExpFailure onRetry={retry} />}
    >
      <Suspense
        fallback={
          <div
            className="flex h-full items-center justify-center text-sm text-text-secondary"
            data-testid="collaboration-exp-loading"
            role="status"
          >
            {t('workbench.collaboration_exp_loading')}
          </div>
        }
      >
        <App active={active} search={search} />
      </Suspense>
    </CollaborationExpErrorBoundary>
  )
}
