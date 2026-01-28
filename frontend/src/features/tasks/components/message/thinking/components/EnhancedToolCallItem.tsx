// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { memo } from 'react'
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion'
import { renderTool } from '../tool-renderers'
import type { ToolMetadata } from '../tool-renderers'
import TodoListDisplay from './TodoListDisplay'
import type { TodoItem } from '../types'

interface EnhancedToolCallItemProps {
  toolName: string
  input?: Record<string, unknown>
  output?: string
  metadata?: ToolMetadata
  isLoading?: boolean
  isError?: boolean
  itemIndex: number
  defaultOpen?: boolean
}

/**
 * Enhanced tool call item with specialized renderers
 * Uses the tool-renderers registry to display tool-specific UI
 */
const EnhancedToolCallItem = memo(function EnhancedToolCallItem({
  toolName,
  input,
  output,
  metadata,
  isLoading,
  isError,
  itemIndex,
  defaultOpen = false,
}: EnhancedToolCallItemProps) {
  // Special handling for TodoWrite - render without accordion
  if (toolName === 'TodoWrite' && input?.todos) {
    const todos = input.todos as TodoItem[]
    if (Array.isArray(todos)) {
      return <TodoListDisplay todos={todos} />
    }
  }

  const toolResult = renderTool(toolName, {
    input,
    output,
    metadata,
    isLoading,
    isError,
    itemIndex,
  })

  return (
    <Accordion
      type="single"
      collapsible
      className="w-full"
      defaultValue={defaultOpen ? toolResult.key : ''}
    >
      <AccordionItem value={toolResult.key} className="border-none">
        <AccordionTrigger className="py-2 px-0 hover:no-underline [&>svg]:h-4 [&>svg]:w-4">
          {toolResult.label}
        </AccordionTrigger>
        <AccordionContent className="pt-2 pb-0">{toolResult.children}</AccordionContent>
      </AccordionItem>
    </Accordion>
  )
})

export default EnhancedToolCallItem
