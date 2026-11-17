import type { CollaborationTranslate } from '../i18n'
import type { HumanTargetAutomationRunReceipt } from './types'

export function HumanAutomationRunDetails({
  receipt,
  translate: t,
}: {
  receipt: HumanTargetAutomationRunReceipt | null
  translate: CollaborationTranslate
}) {
  if (!receipt) return null
  const reason = receipt.reasonCode
    ? t(
        `activity.automation_reason_${receipt.reasonCode}`,
        t(
          `human_assignment_receipt.reason.${receipt.reasonCode}`,
          t('human_assignment_receipt.reason.unavailable')
        )
      )
    : null
  return (
    <div
      data-testid={`human-automation-run-${receipt.automationRunId}`}
      className="mt-2 flex min-w-0 flex-col gap-1 text-xs text-text-secondary"
    >
      {reason ? <span>{reason}</span> : null}
      {receipt.workflowStageId ? (
        <span>
          {t('activity.automation_stage')}: {receipt.workflowStageId}
        </span>
      ) : null}
      {receipt.requiredDeliverables.length ? (
        <span>
          {t('activity.automation_requirements')}:{' '}
          {receipt.requiredDeliverables.map(item => item.name || item.id).join(', ')}
        </span>
      ) : null}
      {receipt.endpointRef ? (
        <span>
          {t('activity.automation_endpoint')}: {receipt.endpointRef}
        </span>
      ) : null}
      {receipt.runtimeTaskId ? (
        <span>
          {t('activity.automation_runtime_task')}: {receipt.runtimeTaskId}
        </span>
      ) : null}
      {receipt.deliveryId ? (
        <span>
          {t('activity.automation_delivery')}: {receipt.deliveryId}
        </span>
      ) : null}
    </div>
  )
}
