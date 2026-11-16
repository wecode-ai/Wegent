// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Bot } from 'lucide-react'
import type { CollaborationTranslate } from '../i18n'
import type { DirectHumanAssignmentReceipt } from '../types'

export function DirectHumanAssignmentReceiptStatus({
  receipt,
  itemId,
  translate: t,
  compact = false,
  onConfigure,
  onOpenTask,
  onOpenDelivery,
}: {
  receipt?: DirectHumanAssignmentReceipt | null
  itemId: string
  translate: CollaborationTranslate
  compact?: boolean
  onConfigure?: () => void
  onOpenTask?: () => void
  onOpenDelivery?: () => void
}) {
  if (!receipt || receipt.issueId !== itemId) return null
  const state = receipt.state
  const needsConfiguration =
    (state === 'blocked_policy' && receipt.reasonCode !== 'permission_denied') ||
    state === 'waiting_device'
  const stateLabel = t(`human_assignment_receipt.state.${state}`)
  const showReason =
    state === 'blocked_policy' ||
    state === 'waiting_device' ||
    state === 'failed' ||
    state === 'cancelling' ||
    state === 'cancelled' ||
    state === 'superseded'
  const fallbackReason =
    state === 'cancelling' || state === 'cancelled' || state === 'superseded'
      ? state
      : 'unavailable'
  const reason =
    showReason && receipt.reasonCode
      ? t(
          `human_assignment_receipt.reason.${receipt.reasonCode}`,
          t(`human_assignment_receipt.reason.${fallbackReason}`)
        )
      : null
  return (
    <span
      data-testid={`human-assistant-dispatch-${itemId}`}
      data-receipt-state={state}
      className="mt-2 flex min-w-0 flex-wrap items-center gap-2 text-xs text-text-secondary"
      title={reason ?? stateLabel}
    >
      <span className="inline-flex items-center gap-1">
        <Bot className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {t('human_assignment_receipt.label')}: {stateLabel}
      </span>
      {!compact && reason ? <span>{reason}</span> : null}
      {!compact && receipt.runtimeTaskId != null && onOpenTask ? (
        <button
          type="button"
          className="text-text-primary underline underline-offset-2 max-md:min-h-11 max-md:min-w-11"
          data-testid={`human-assistant-execution-${itemId}`}
          onClick={onOpenTask}
        >
          {t('human_assignment_receipt.open_task')}
        </button>
      ) : null}
      {!compact && receipt.deliveryId != null && onOpenDelivery ? (
        <button
          type="button"
          className="text-text-primary underline underline-offset-2 max-md:min-h-11 max-md:min-w-11"
          data-testid={`human-assistant-delivery-${itemId}`}
          onClick={onOpenDelivery}
        >
          {t('human_assignment_receipt.open_delivery')}
        </button>
      ) : null}
      {!compact && needsConfiguration && onConfigure ? (
        <button
          type="button"
          className="text-text-primary underline underline-offset-2 max-md:min-h-11 max-md:min-w-11"
          data-testid={`human-assistant-configure-${itemId}`}
          onClick={onConfigure}
        >
          {t('human_assignment_receipt.configure')}
        </button>
      ) : null}
    </span>
  )
}
