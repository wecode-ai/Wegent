// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useTranslation } from '@/hooks/useTranslation'
import type { ToolRendererProps, ToolRenderResult, EditToolInput } from '../types'
import { ToolHeader, SkeletonValue, TruncatedIndicator } from '../components'
import { truncateOutput, extractFileName } from '../utils'

/**
 * Renderer for Edit tool
 */
export function EditToolRenderer(props: ToolRendererProps<EditToolInput>): ToolRenderResult {
  const { t } = useTranslation('chat')
  const { toolName, input, output, metadata, isLoading } = props

  const fileName = metadata?.file_name || extractFileName(input?.file_path) || input?.file_path

  const { data: truncatedOutput, isTruncated, originalLength } = truncateOutput(output)

  return {
    key: `${toolName}-${props.itemIndex}`,
    label: (
      <ToolHeader
        toolName={toolName}
        params={<SkeletonValue value={fileName} width="120px" />}
        duration={metadata?.duration_ms}
        isLoading={isLoading}
      />
    ),
    children: (
      <div className="text-sm space-y-3">
        {/* Old string */}
        {input?.old_string && (
          <div>
            <div className="mb-1 font-medium text-text-secondary text-xs">
              {t('thinking.sections.oldContent') || 'Old Content'}
            </div>
            <pre className="whitespace-pre-wrap break-words font-mono text-xs text-red-400/80 overflow-x-auto max-h-40 overflow-y-auto rounded-md bg-red-50 dark:bg-red-900/20 p-2">
              {input.old_string}
            </pre>
          </div>
        )}

        {/* New string */}
        {input?.new_string && (
          <div>
            <div className="mb-1 font-medium text-text-secondary text-xs">
              {t('thinking.sections.newContent') || 'New Content'}
            </div>
            <pre className="whitespace-pre-wrap break-words font-mono text-xs text-green-400/80 overflow-x-auto max-h-40 overflow-y-auto rounded-md bg-green-50 dark:bg-green-900/20 p-2">
              {input.new_string}
            </pre>
          </div>
        )}

        {/* Output */}
        {truncatedOutput ? (
          <div>
            <div className="mb-1 font-medium text-text-secondary text-xs">
              {t('thinking.sections.output') || 'Output'}
            </div>
            <pre className="whitespace-pre-wrap break-words font-mono text-xs text-text-tertiary overflow-x-auto max-h-40 overflow-y-auto rounded-md bg-muted/30 p-2">
              {truncatedOutput}
            </pre>
            {isTruncated && <TruncatedIndicator originalLength={originalLength} />}
          </div>
        ) : isLoading ? (
          <SkeletonValue value={null} width="100%" height="60px" />
        ) : null}
      </div>
    ),
  }
}
