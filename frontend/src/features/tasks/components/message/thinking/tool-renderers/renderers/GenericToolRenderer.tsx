// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useTranslation } from '@/hooks/useTranslation'
import type { ToolRendererProps, ToolRenderResult } from '../types'
import { ToolHeader, SkeletonValue, TruncatedIndicator } from '../components'
import { truncateOutput } from '../utils'

/**
 * Generic renderer for unknown tools
 */
export function GenericToolRenderer(
  props: ToolRendererProps<Record<string, unknown>>
): ToolRenderResult {
  const { t } = useTranslation('chat')
  const { toolName, input, output, metadata, isLoading, isError } = props

  const { data: truncatedOutput, isTruncated, originalLength } = truncateOutput(output)

  // Extract a meaningful param to show in the header
  const firstParam = input ? Object.entries(input)[0] : undefined
  const paramDisplay = firstParam
    ? `${firstParam[0]}: ${typeof firstParam[1] === 'string' ? firstParam[1].slice(0, 30) : '...'}`
    : undefined

  return {
    key: `${toolName}-${props.itemIndex}`,
    label: (
      <ToolHeader
        toolName={toolName}
        params={<SkeletonValue value={paramDisplay} width="150px" />}
        duration={metadata?.duration_ms}
        isLoading={isLoading}
        isError={isError}
      />
    ),
    children: (
      <div className="text-sm space-y-2">
        {/* Input parameters */}
        {input && Object.keys(input).length > 0 && (
          <div>
            <div className="mb-1 font-medium text-text-secondary text-xs">
              {t('thinking.sections.input') || 'Input'}
            </div>
            <pre className="whitespace-pre-wrap break-words font-mono text-xs text-text-tertiary overflow-x-auto max-h-40 overflow-y-auto rounded-md bg-muted/30 p-2">
              {JSON.stringify(input, null, 2)}
            </pre>
          </div>
        )}

        {/* Output */}
        {truncatedOutput ? (
          <div>
            <div className="mb-1 font-medium text-text-secondary text-xs">
              {t('thinking.sections.output') || 'Output'}
            </div>
            <pre className="whitespace-pre-wrap break-words font-mono text-xs text-text-tertiary overflow-x-auto max-h-60 overflow-y-auto rounded-md bg-muted/30 p-2">
              {truncatedOutput}
            </pre>
            {isTruncated && <TruncatedIndicator originalLength={originalLength} />}
          </div>
        ) : isLoading ? (
          <SkeletonValue value={null} width="100%" height="80px" />
        ) : null}
      </div>
    ),
  }
}
