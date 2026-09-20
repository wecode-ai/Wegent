import { useState } from 'react'
import type { CollaborationIssue } from '../types'
import { useExecutionRuntimeConfiguration } from './context'

export function ExecutionConfigurationNotice({
  issue,
  translate: t,
}: {
  issue: Pick<
    CollaborationIssue,
    | 'id'
    | 'execution_id'
    | 'execution_state'
    | 'assignee_agent_id'
    | 'assignee_agent_name'
  >
  translate: (key: string, fallback?: string) => string
}) {
  const configure = useExecutionRuntimeConfiguration()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [configuredId, setConfiguredId] = useState<number | null>(null)
  if (issue.execution_state !== 'waiting_runtime') return null
  if (configuredId === issue.execution_id)
    return <p role="status">{t('runtimeSettings.executionSaved')}</p>

  async function open() {
    if (!configure || busy) return
    setBusy(true)
    setError('')
    try {
      await configure(issue, (execution) => setConfiguredId(execution.id))
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t('runtimeSettings.loadFailed'),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      role="alert"
      className="my-3 rounded-lg border border-border p-3 text-sm"
      data-testid={`execution-configuration-notice-${issue.id}`}
    >
      <p>
        {issue.assignee_agent_name ? `${issue.assignee_agent_name}：` : ''}
        {t('runtimeSettings.executionBlocked')}
      </p>
      {configure && issue.execution_id ? (
        <button
          type="button"
          className="collaboration-primary-button mt-2 min-h-11"
          data-testid={`execution-configure-${issue.id}`}
          disabled={busy}
          onClick={() => void open()}
        >
          {busy ? t('common.loading') : t('runtimeSettings.executionConfigure')}
        </button>
      ) : (
        <p>{t('runtimeSettings.ownerRequired')}</p>
      )}
      {error ? (
        <p role="alert" className="mt-2">
          {error}
        </p>
      ) : null}
    </div>
  )
}
