import { useState } from 'react'
import type { ConnectionAutomationRule } from '@wegent/collaboration/automation'
import { useTranslation } from '@/hooks/useTranslation'

export function ConnectionRuleRunnerButton({
  rule,
  configure,
  onChange,
}: {
  rule: ConnectionAutomationRule
  configure(rule: ConnectionAutomationRule): Promise<ConnectionAutomationRule>
  onChange(selection: ConnectionAutomationRule['runnerSelection']): void
}) {
  const { t } = useTranslation('common')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [verified, setVerified] = useState(false)
  return (
    <div className="space-y-1">
      <button
        type="button"
        className="min-h-11 px-2 text-sm underline md:min-h-8"
        disabled={busy}
        data-testid="connection-rule-runner"
        onClick={async () => {
          setBusy(true)
          setError('')
          setVerified(false)
          try {
            onChange((await configure({ ...rule, runnerSelection: undefined })).runnerSelection)
            setVerified(true)
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause))
          } finally {
            setBusy(false)
          }
        }}
      >
        {t('automation_rules.configure_runner')}
      </button>
      <p className="text-xs text-text-muted">
        {rule.runnerSelection?.model?.model_id ?? t('automation_rules.runner_agent_policy')}
      </p>
      {verified && (
        <p role="status" className="text-xs text-text-muted">
          {t('automation_rules.runner_verified')}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
