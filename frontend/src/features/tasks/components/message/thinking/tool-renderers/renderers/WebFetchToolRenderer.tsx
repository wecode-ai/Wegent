// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useTranslation } from '@/hooks/useTranslation'
import type { ToolRendererProps, ToolRenderResult, WebFetchToolInput } from '../types'
import { ToolHeader, SkeletonValue, TruncatedIndicator } from '../components'
import { truncateOutput, truncateText } from '../utils'

/**
 * Renderer for WebFetch tool
 */
export function WebFetchToolRenderer(
  props: ToolRendererProps<WebFetchToolInput>
): ToolRenderResult {
  const { t } = useTranslation('chat')
  const { toolName, input, output, metadata, isLoading, isError } = props

  const url = metadata?.url || input?.url
  const urlPreview = url ? truncateText(url, 50) : undefined

  const { data: truncatedOutput, isTruncated, originalLength } = truncateOutput(output)

  return {
    key: `${toolName}-${props.itemIndex}`,
    label: (
      <ToolHeader
        toolName={toolName}
        params={<SkeletonValue value={urlPreview} width="200px" />}
        duration={metadata?.duration_ms}
        isLoading={isLoading}
        isError={isError}
      />
    ),
    children: (
      <div className="text-sm space-y-2">
        {/* URL */}
        {url && (
          <div>
            <div className="mb-1 font-medium text-text-secondary text-xs">URL</div>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-blue-500 hover:underline break-all"
            >
              {url}
            </a>
          </div>
        )}

        {/* Prompt */}
        {input?.prompt && (
          <div>
            <div className="mb-1 font-medium text-text-secondary text-xs">
              {t('thinking.sections.prompt') || 'Prompt'}
            </div>
            <div className="text-xs text-text-tertiary bg-muted/30 p-2 rounded-md">
              {input.prompt}
            </div>
          </div>
        )}

        {/* Content */}
        {truncatedOutput ? (
          <div>
            <div className="mb-1 font-medium text-text-secondary text-xs">
              {t('thinking.sections.content') || 'Content'}
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
