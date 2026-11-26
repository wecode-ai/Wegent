import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { getErrorMessage } from '@/lib/error-message'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { RuntimeTaskAddress } from '@/types/api'

export function PersonalPipelineConfirmation({
  handle,
  address,
  services,
}: {
  handle?: Record<string, unknown> | null
  address: RuntimeTaskAddress
  services?: WorkbenchServices | null
}) {
  const { t } = useTranslation('common')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const state = handle?.personalPipeline as Record<string, unknown> | undefined
  const api = services?.runtimeWorkApi
  if (
    !api ||
    state?.phase !== 'confirmation' ||
    typeof state.root !== 'string' ||
    typeof state.stage !== 'number'
  )
    return null
  const expected = [state.root, state.stage] as [string, number]
  const confirm = async () => {
    setSending(true)
    setError('')
    try {
      await api.sendRuntimeMessage({
        address,
        message: '',
        action: 'pipeline:confirm',
        expectedStage: expected,
      })
    } catch (cause) {
      setError(getErrorMessage(cause, t('standIn.pipeline_confirmation_failed')))
    } finally {
      setSending(false)
    }
  }
  return (
    <div>
      <Button
        type="button"
        data-testid="personal-pipeline-confirm"
        disabled={sending}
        onClick={() => void confirm()}
      >
        {t('standIn.confirm_pipeline_stage')}
      </Button>
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
