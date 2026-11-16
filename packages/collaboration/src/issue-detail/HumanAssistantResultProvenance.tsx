// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ProjectChatMessage } from '@wegent/chat-core'
import type { CollaborationTranslate } from '../i18n'

export function HumanAssistantResultProvenance({
  message,
  translate: t,
  onOpenExecution,
}: {
  message: ProjectChatMessage
  translate: CollaborationTranslate
  onOpenExecution?: () => void
}) {
  const provenance = message.metadata.provenance as Record<string, unknown> | undefined
  if (
    message.metadata.activity_type !== 'human_assistant_result' ||
    provenance?.origin !== 'ai_generated'
  )
    return null
  const publisherId = provenance.publisher_user_id
  const publisher =
    String(publisherId) === String(message.sender.id)
      ? message.sender.name
      : String(publisherId ?? '')
  const executionId = message.metadata.execution_id
  const executionLabel =
    executionId == null
      ? null
      : t('human_assistant.execution', undefined, { id: String(executionId) })
  return (
    <div
      className="mt-2 flex flex-wrap items-center gap-2 text-xs text-text-muted"
      data-testid={`human-assistant-provenance-${message.messageId}`}
    >
      <span>{t('human_assistant.ai_generated')}</span>
      <span>{t('human_assistant.publisher', undefined, { name: publisher })}</span>
      <span>
        {t(
          provenance.confirmation_status === 'confirmed'
            ? 'human_assistant.confirmed'
            : 'human_assistant.unconfirmed'
        )}
      </span>
      {executionLabel ? (
        onOpenExecution ? (
          <button
            type="button"
            className="text-text-primary underline underline-offset-2 max-md:min-h-11 max-md:min-w-11"
            data-testid={`human-assistant-result-execution-${message.messageId}`}
            onClick={onOpenExecution}
          >
            {executionLabel}
          </button>
        ) : (
          <span>{executionLabel}</span>
        )
      ) : null}
    </div>
  )
}
