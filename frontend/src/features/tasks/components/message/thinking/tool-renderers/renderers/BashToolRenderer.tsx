// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'
import type { ToolRendererProps, ToolRenderResult, BashToolInput } from '../types'
import { ToolHeader, SkeletonValue, TruncatedIndicator } from '../components'
import { truncateOutput, truncateText } from '../utils'

/**
 * Renderer for Bash tool
 */
export function BashToolRenderer(props: ToolRendererProps<BashToolInput>): ToolRenderResult {
  const { t } = useTranslation('chat')
  const { toolName, input, output, metadata, isLoading, isError } = props

  const description = metadata?.command_description || input?.description
  const { data: truncatedOutput, isTruncated, originalLength } = truncateOutput(output)

  // Truncate command for header display
  const commandPreview = input?.command ? truncateText(input.command, 50) : undefined

  return {
    key: `${toolName}-${props.itemIndex}`,
    label: (
      <ToolHeader
        toolName={toolName}
        params={<SkeletonValue value={description || commandPreview} width="150px" />}
        duration={metadata?.duration_ms}
        isLoading={isLoading}
        isError={isError}
      />
    ),
    children: (
      <div className="flex flex-col gap-3">
        {/* Command */}
        {input?.command && (
          <div>
            <div className="mb-1 font-medium text-text-secondary text-xs">
              {t('thinking.sections.command') || 'Command'}
            </div>
            <div className="max-h-40 overflow-y-auto rounded-md bg-muted/50 p-2">
              <code className="whitespace-pre-wrap break-all font-mono text-xs">
                {input.command}
              </code>
            </div>
          </div>
        )}

        {/* Output */}
        {truncatedOutput ? (
          <div>
            <div className="mb-1 font-medium text-text-secondary text-xs">
              {t('thinking.sections.output') || 'Output'}
            </div>
            <div
              className={cn(
                'max-h-60 overflow-y-auto rounded-md p-2',
                isError ? 'bg-red-50 dark:bg-red-900/20' : 'bg-muted/30'
              )}
            >
              <pre
                className={cn(
                  'whitespace-pre-wrap font-mono text-xs',
                  isError && 'text-red-600 dark:text-red-400'
                )}
              >
                {truncatedOutput}
              </pre>
            </div>
            {isTruncated && <TruncatedIndicator originalLength={originalLength} />}
          </div>
        ) : isLoading ? (
          <SkeletonValue value={null} width="100%" height="80px" />
        ) : null}

        {/* Exit code if error */}
        {metadata?.exit_code !== undefined && metadata.exit_code !== 0 && (
          <div className="text-xs text-red-500">Exit code: {metadata.exit_code}</div>
        )}
      </div>
    ),
  }
}
