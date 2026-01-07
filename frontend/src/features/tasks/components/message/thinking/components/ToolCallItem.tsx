// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { memo, useState } from 'react'
import { Maximize2, Minimize2 } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { ToolCallItemProps } from '../types'
import { shouldCollapse, getContentPreview } from '../utils/thinkingUtils'
import TodoListDisplay from './TodoListDisplay'
import type { TodoItem } from '../types'

/**
 * Component to display a single tool call with name and parameters
 */
const ToolCallItem = memo(function ToolCallItem({ toolName, input, itemIndex }: ToolCallItemProps) {
  const { t } = useTranslation()
  const [expandedParams, setExpandedParams] = useState<Set<string>>(new Set())

  const toggleParamExpansion = (paramKey: string) => {
    setExpandedParams(prev => {
      const newSet = new Set(prev)
      if (newSet.has(paramKey)) {
        newSet.delete(paramKey)
      } else {
        newSet.add(paramKey)
      }
      return newSet
    })
  }

  // Special handling for TodoWrite tool
  if (toolName === 'TodoWrite' && input && 'todos' in input) {
    const todos = input.todos as TodoItem[]
    if (Array.isArray(todos)) {
      return <TodoListDisplay todos={todos} />
    }
  }

  const renderParamValue = (key: string, value: unknown, uniqueId: string) => {
    const stringValue = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    const isCollapsible = shouldCollapse(stringValue)
    const paramKey = `${uniqueId}-${key}`
    const isExpanded = expandedParams.has(paramKey)
    const displayValue = isCollapsible && !isExpanded ? getContentPreview(stringValue) : stringValue

    return (
      <div key={paramKey} className="text-xs">
        <div className="flex items-center justify-between mb-0.5">
          <span className="font-medium text-blue-300">{key}:</span>
          {isCollapsible && (
            <button
              onClick={() => toggleParamExpansion(paramKey)}
              className="flex items-center gap-1 text-blue-400 hover:text-blue-500 hover:font-semibold transition-colors"
              title={isExpanded ? t('chat:thinking.collapse') : t('chat:thinking.expand')}
            >
              {isExpanded ? (
                <>
                  <Minimize2 className="h-3 w-3" />
                  <span className="text-xs">{t('chat:thinking.collapse') || 'Collapse'}</span>
                </>
              ) : (
                <>
                  <Maximize2 className="h-3 w-3" />
                  <span className="text-xs">{t('chat:thinking.expand') || 'Expand'}</span>
                </>
              )}
            </button>
          )}
        </div>
        <pre className="text-text-tertiary overflow-x-auto whitespace-pre-wrap break-words">
          {displayValue}
          {isCollapsible && !isExpanded && <span className="text-blue-400">...</span>}
        </pre>
      </div>
    )
  }

  return (
    <div className="mt-1">
      <div className="text-xs font-medium text-blue-400 mb-1">
        {t('chat:thinking.tool_use') || 'Tool Use'}: {toolName}
      </div>
      {input && (
        <div className="space-y-2">
          {typeof input === 'object' && !Array.isArray(input) ? (
            Object.entries(input).map(([key, value]) =>
              renderParamValue(key, value, `item-${itemIndex}-${key}`)
            )
          ) : (
            <pre className="text-xs text-text-tertiary overflow-x-auto">
              {JSON.stringify(input, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  )
})

export default ToolCallItem
