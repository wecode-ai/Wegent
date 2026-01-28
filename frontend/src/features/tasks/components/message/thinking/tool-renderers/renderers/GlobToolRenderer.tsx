// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useTranslation } from '@/hooks/useTranslation'
import type { ToolRendererProps, ToolRenderResult, GlobToolInput } from '../types'
import { ToolHeader, SkeletonValue, TruncatedIndicator } from '../components'
import { truncateOutput, formatMatchCount } from '../utils'

/**
 * Renderer for Glob tool
 */
export function GlobToolRenderer(props: ToolRendererProps<GlobToolInput>): ToolRenderResult {
  const { t } = useTranslation('chat')
  const { toolName, input, output, metadata, isLoading } = props

  const pattern = input?.pattern
  const matchCount = metadata?.match_count
  const stats =
    matchCount !== undefined
      ? `${formatMatchCount(matchCount)} ${t('thinking.units.files') || 'files'}`
      : undefined

  const { data: truncatedOutput, isTruncated, originalLength } = truncateOutput(output)

  return {
    key: `${toolName}-${props.itemIndex}`,
    label: (
      <ToolHeader
        toolName={toolName}
        params={<SkeletonValue value={pattern ? `"${pattern}"` : null} width="150px" />}
        stats={stats}
        duration={metadata?.duration_ms}
        isLoading={isLoading}
      />
    ),
    children: (
      <div className="text-sm space-y-2">
        {/* Pattern */}
        {pattern && (
          <div>
            <div className="mb-1 font-medium text-text-secondary text-xs">
              {t('thinking.sections.pattern') || 'Pattern'}
            </div>
            <code className="text-xs bg-muted/50 px-2 py-1 rounded font-mono">{pattern}</code>
          </div>
        )}

        {/* Results */}
        {truncatedOutput ? (
          <div>
            <div className="mb-1 font-medium text-text-secondary text-xs">
              {t('thinking.sections.files') || 'Files'}
            </div>
            <pre className="whitespace-pre-wrap break-words font-mono text-xs text-text-tertiary overflow-x-auto max-h-60 overflow-y-auto rounded-md bg-muted/30 p-2">
              {truncatedOutput}
            </pre>
            {isTruncated && <TruncatedIndicator originalLength={originalLength} unit="lines" />}
          </div>
        ) : isLoading ? (
          <SkeletonValue value={null} width="100%" height="80px" />
        ) : (
          <span className="text-text-tertiary text-xs">
            {t('thinking.no_files') || 'No files found'}
          </span>
        )}
      </div>
    ),
  }
}
