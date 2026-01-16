// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { memo } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { ErrorDisplayProps } from '../types'

/**
 * Component to display error information
 */
const ErrorDisplay = memo(function ErrorDisplay({
  errorMessage,
  executionType,
}: ErrorDisplayProps) {
  const { t } = useTranslation()

  return (
    <div>
      <div className="space-y-2">
        {errorMessage && (
          <div className="text-xs">
            <span className="font-medium text-red-300">
              {t('chat:thinking.error_message') || 'Error Message'}:
            </span>
            <pre className="mt-1 text-text-tertiary overflow-x-auto whitespace-pre-wrap break-words">
              {errorMessage}
            </pre>
          </div>
        )}
        {executionType && (
          <div className="text-xs">
            <span className="font-medium text-red-300">
              {t('chat:thinking.execution_type') || 'Execution Type'}:
            </span>
            <span className="ml-2 text-text-tertiary">{executionType}</span>
          </div>
        )}
      </div>
    </div>
  )
})

export default ErrorDisplay
