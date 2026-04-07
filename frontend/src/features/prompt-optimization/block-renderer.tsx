// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Prompt Optimization Block Renderer Registration
 *
 * This module registers the prompt optimization block renderer with the
 * global block renderer registry. This allows MixedContentView to render
 * prompt optimization blocks without hardcoding the rendering logic.
 *
 * The registration happens at module load time, so importing this module
 * is sufficient to enable the renderer.
 */

import { blockRendererRegistry } from '@/features/tasks/components/message/block-registry'
import { PromptOptimizationBlock } from './components/PromptOptimizationBlock'
import type { MessageBlock } from '@/features/tasks/components/message/thinking/types'

/**
 * Type guard for submit_prompt_changes tool block
 * Backend sends this as a tool block, not a prompt_optimization block
 */
function isSubmitPromptChangesTool(block: MessageBlock): boolean {
  return (
    block.type === 'tool' &&
    !!block.tool_name?.includes('submit_prompt_changes') &&
    !!block.tool_input
  )
}

/**
 * Register the prompt optimization block renderer
 */
function registerPromptOptimizationRenderer(): void {
  blockRendererRegistry.register({
    id: 'prompt-optimization',
    priority: 100, // High priority to handle before default renderers
    canRender: block => isSubmitPromptChangesTool(block),
    render: ({ block }) => {
      // Extract data from tool block
      const toolBlock = block as Extract<MessageBlock, { type: 'tool' }>
      const input = toolBlock.tool_input as Record<string, unknown> | undefined
      const changes = input?.changes as
        | Array<{
            type: 'ghost' | 'member'
            id: number
            name: string
            field: string
            original: string
            suggested: string
            index?: number
          }>
        | undefined
      const applyAction = input?.apply_action as
        | {
            endpoint: string
            method: string
            payload: {
              team_id: number
              changes: Array<{
                type: 'ghost' | 'member'
                id?: number
                team_id?: number
                index?: number
                field?: string
                value: string
              }>
            }
          }
        | undefined

      if (!changes || !Array.isArray(changes) || !applyAction) {
        return null
      }

      return <PromptOptimizationBlock changes={changes} apply_action={applyAction} />
    },
  })
}

// Register on module load
registerPromptOptimizationRenderer()

// Export for explicit registration if needed
export { registerPromptOptimizationRenderer }
