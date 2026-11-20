import { useRef, useState } from 'react'
import { Check, ChevronDown, Loader2 } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type {
  ModelProvider,
  PublicModelProvider,
} from '@/features/model-settings/providerModelConfiguration'
import { testProviderConnection } from '@/features/model-settings/providerConnectionTest'

interface ProviderConnectionTestButtonProps {
  provider: ModelProvider | PublicModelProvider
  disabled?: boolean
  testId: string
}

/** Test the current editor draft without persisting it. */
export function ProviderConnectionTestButton(props: ProviderConnectionTestButtonProps) {
  return <ScopedProviderConnectionTestButton key={JSON.stringify(props.provider)} {...props} />
}

function ScopedProviderConnectionTestButton({
  provider,
  disabled = false,
  testId,
}: ProviderConnectionTestButtonProps) {
  const { t } = useTranslation('modelConnections')
  const pending = useRef(false)
  const [current, setStatus] = useState<{
    pending: boolean
    message?: string
    failed?: boolean
  } | null>(null)
  async function test() {
    if (pending.current) return
    pending.current = true
    setStatus({ pending: true })
    try {
      const results = await testProviderConnection(provider)
      const failures = results.filter(result => result.error)
      setStatus({
        pending: false,
        failed: failures.length > 0,
        message: failures.length
          ? failures
              .map(
                result =>
                  `${result.model}: ${result.error === 'connection_test_failed' ? t('testFailed') : result.error}`
              )
              .join('\n')
          : t('testSuccess'),
      })
    } catch (error) {
      setStatus({
        pending: false,
        failed: true,
        message: error instanceof Error ? error.message : t('failed'),
      })
    } finally {
      pending.current = false
    }
  }
  return (
    <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-2">
      <button
        type="button"
        data-testid={testId}
        disabled={
          disabled ||
          current?.pending ||
          !provider.models.length ||
          provider.models.some(model => !model.model_id.trim()) ||
          !provider.base_url
        }
        className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md px-2 text-sm text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-45 md:min-h-8"
        onClick={event => {
          event.preventDefault()
          void test()
        }}
      >
        {current?.pending && <Loader2 className="h-4 w-4 animate-spin" />}
        {current?.pending ? t('testing') : t('testConnection')}
      </button>
      {current?.message && current.failed && (
        <details
          role="alert"
          data-testid={`${testId}-result`}
          className="group min-w-0 text-xs text-destructive wework:text-red-500"
        >
          <summary
            data-testid={`${testId}-error-details`}
            className="flex min-h-11 cursor-pointer items-center gap-1 md:min-h-8"
          >
            {t('testFailed')}
            <ChevronDown
              aria-hidden="true"
              className="h-3.5 w-3.5 shrink-0 group-open:rotate-180"
            />
          </summary>
          <p className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words py-2">
            {current.message}
          </p>
        </details>
      )}
      {current?.message && !current.failed && (
        <p
          role="status"
          data-testid={`${testId}-result`}
          className="flex min-h-11 items-center gap-1 text-xs text-text-secondary md:min-h-8"
        >
          <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          {current.message}
        </p>
      )}
    </div>
  )
}
