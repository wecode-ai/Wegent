// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useTranslation } from '@/hooks/useTranslation'
import type { ToolRendererProps, ToolRenderResult, WebSearchToolInput } from '../types'
import { ToolHeader, SkeletonValue, TruncatedIndicator } from '../components'
import { truncateOutput, formatMatchCount } from '../utils'

/**
 * Renderer for WebSearch tool
 */
export function WebSearchToolRenderer(
  props: ToolRendererProps<WebSearchToolInput>
): ToolRenderResult {
  const { t } = useTranslation('chat')
  const { toolName, input, output, metadata, isLoading, isError } = props

  const query = input?.query || metadata?.url // url is used to store query in metadata
  const resultCount = metadata?.result_count
  const stats =
    resultCount !== undefined
      ? `${formatMatchCount(resultCount)} ${t('messages.results') || 'results'}`
      : undefined

  const { data: truncatedOutput, isTruncated, originalLength } = truncateOutput(output)

  return {
    key: `${toolName}-${props.itemIndex}`,
    label: (
      <ToolHeader
        toolName={toolName}
        params={<SkeletonValue value={query ? `"${query}"` : null} width="200px" />}
        stats={stats}
        duration={metadata?.duration_ms}
        isLoading={isLoading}
        isError={isError}
      />
    ),
    children: (
      <div className="text-sm space-y-2">
        {/* Query */}
        {query && (
          <div>
            <div className="mb-1 font-medium text-text-secondary text-xs">
              {t('messages.query') || 'Query'}
            </div>
            <div className="text-xs text-text-primary bg-muted/50 px-2 py-1 rounded">{query}</div>
          </div>
        )}

        {/* Results */}
        {truncatedOutput ? (
          <div>
            <div className="mb-1 font-medium text-text-secondary text-xs">
              {t('thinking.sections.searchResults') || 'Results'}
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
