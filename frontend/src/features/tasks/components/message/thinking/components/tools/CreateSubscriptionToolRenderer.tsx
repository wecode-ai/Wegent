// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useTranslation } from '@/hooks/useTranslation'
import type { ToolRendererProps } from '../../types'
import SubscriptionInlineCard from '@/components/common/SubscriptionInlineCard'

/**
 * Renderer for create_subscription tool results.
 * When a subscription is successfully created, renders the SubscriptionInlineCard
 * so users can enable and configure it directly.
 */
export function CreateSubscriptionToolRenderer({ tool }: ToolRendererProps) {
  const { t } = useTranslation('chat')

  // Extract output
  const outputRaw = tool.toolResult?.details?.content || tool.toolResult?.details?.output
  const isError = tool.toolResult?.details?.is_error || tool.toolResult?.details?.error

  // Parse output to extract subscription ID
  let subscriptionId: number | null = null
  let outputDisplay: string | null = null

  if (outputRaw) {
    if (typeof outputRaw === 'string') {
      try {
        const parsed = JSON.parse(outputRaw)
        if (parsed.success && parsed.subscription?.id) {
          subscriptionId = parsed.subscription.id
        }
        outputDisplay = outputRaw
      } catch {
        outputDisplay = outputRaw
      }
    } else if (typeof outputRaw === 'object') {
      const obj = outputRaw as Record<string, unknown>
      if (obj.success && typeof obj.subscription === 'object' && obj.subscription !== null) {
        const sub = obj.subscription as Record<string, unknown>
        if (typeof sub.id === 'number') {
          subscriptionId = sub.id
        }
      }
      outputDisplay = JSON.stringify(outputRaw, null, 2)
    }
  }

  return (
    <div className="space-y-3">
      {/* Show subscription inline card if creation succeeded */}
      {subscriptionId && !isError && (
        <div className="mb-3">
          <SubscriptionInlineCard subscriptionId={subscriptionId} />
        </div>
      )}

      {/* Show raw JSON output (collapsed if card is shown) */}
      {outputDisplay && (
        <details open={!subscriptionId}>
          <summary className="cursor-pointer text-xs text-text-muted hover:text-text-secondary mb-2">
            {subscriptionId ? 'View raw response' : 'Response details'}
          </summary>
          <pre
            className={`text-xs p-2 rounded overflow-x-auto whitespace-pre-wrap break-words ${
              isError
                ? 'text-yellow-700 bg-yellow-50 border border-yellow-200'
                : 'text-text-tertiary bg-fill-tert'
            }`}
          >
            {outputDisplay}
          </pre>
        </details>
      )}

      {/* No output yet (streaming) */}
      {!outputDisplay && tool.status === 'invoking' && (
        <div className="text-xs text-text-muted italic">
          {t('thinking.tool_executing') || 'Executing...'}
        </div>
      )}
    </div>
  )
}

export default CreateSubscriptionToolRenderer
