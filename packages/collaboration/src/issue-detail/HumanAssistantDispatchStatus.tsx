// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Bot } from 'lucide-react'
import type { CollaborationTranslate } from '../i18n'
import type { HumanAssistantDispatch } from '../types'

export function HumanAssistantDispatchStatus({
  dispatch,
  itemId,
  translate: t,
  compact = false,
  onConfigure,
  onOpenExecution,
}: {
  dispatch?: HumanAssistantDispatch | null
  itemId: string
  translate: CollaborationTranslate
  compact?: boolean
  onConfigure?: () => void
  onOpenExecution?: () => void
}) {
  if (!dispatch) return null
  const state = dispatch.dispatchState
  const needsConfiguration = state === 'no_authorized_assistant' || state === 'waiting_device'
  const stateLabel = t(`human_assistant.state.${state}`)
  const showReason =
    needsConfiguration || state === 'failed' || state === 'cancelling' || state === 'cancelled'
  const fallbackReason = state === 'cancelling' || state === 'cancelled' ? state : 'unavailable'
  const reason =
    showReason && dispatch.reasonCode
      ? t(
          `human_assistant.reason.${dispatch.reasonCode}`,
          t(`human_assistant.reason.${fallbackReason}`)
        )
      : null
  return (
    <span
      data-testid={`human-assistant-dispatch-${itemId}`}
      data-dispatch-state={state}
      className="mt-2 flex min-w-0 flex-wrap items-center gap-2 text-xs text-text-secondary"
      title={reason ?? stateLabel}
    >
      <span className="inline-flex items-center gap-1">
        <Bot className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {t('human_assistant.label')}: {stateLabel}
      </span>
      {!compact && reason ? <span>{reason}</span> : null}
      {!compact && dispatch.executionId != null ? (
        onOpenExecution ? (
          <button
            type="button"
            className="text-text-primary underline underline-offset-2 max-md:min-h-11 max-md:min-w-11"
            data-testid={`human-assistant-execution-${itemId}`}
            onClick={onOpenExecution}
          >
            {t('human_assistant.execution', undefined, { id: dispatch.executionId })}
          </button>
        ) : (
          <span data-testid={`human-assistant-execution-${itemId}`}>
            {t('human_assistant.execution', undefined, { id: dispatch.executionId })}
          </span>
        )
      ) : null}
      {!compact && needsConfiguration && onConfigure ? (
        <button
          type="button"
          className="text-text-primary underline underline-offset-2 max-md:min-h-11 max-md:min-w-11"
          data-testid={`human-assistant-configure-${itemId}`}
          onClick={onConfigure}
        >
          {t('human_assistant.configure')}
        </button>
      ) : null}
    </span>
  )
}
