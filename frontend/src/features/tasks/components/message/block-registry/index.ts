// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { ReactNode } from 'react'
import type { MessageBlock } from '../thinking/types'

/**
 * Context passed to block renderers
 */
export interface BlockRenderContext {
  /** The block to render */
  block: MessageBlock
  /** Whether this is the last block in the list */
  isLastBlock: boolean
  /** Task ID for context */
  taskId?: number
  /** Subtask ID for context */
  subtaskId?: number
  /** Current message index */
  currentMessageIndex?: number
}

/**
 * Block renderer interface
 * Allows modules to register custom block renderers
 */
export interface BlockRenderer {
  /** Priority - higher numbers are checked first (default: 0) */
  priority: number
  /** Unique identifier for this renderer */
  id: string
  /**
   * Check if this renderer can handle the given block
   * @param block - The message block to check
   * @returns true if this renderer can render the block
   */
  canRender: (block: MessageBlock) => boolean
  /**
   * Render the block
   * @param context - The render context
   * @returns React node to render
   */
  render: (context: BlockRenderContext) => ReactNode
}

/**
 * Registry for block renderers
 * Allows feature modules to register their own block renderers
 * without modifying the core MixedContentView component
 */
class BlockRendererRegistry {
  private renderers: BlockRenderer[] = []

  /**
   * Register a block renderer
   * @param renderer - The renderer to register
   */
  register(renderer: BlockRenderer): void {
    this.renderers.push(renderer)
    // Sort by priority (descending)
    this.renderers.sort((a, b) => b.priority - a.priority)
  }

  /**
   * Unregister a block renderer by id
   * @param id - The renderer id to unregister
   */
  unregister(id: string): void {
    this.renderers = this.renderers.filter(r => r.id !== id)
  }

  /**
   * Find a renderer that can handle the given block
   * @param block - The message block to render
   * @returns The matching renderer or undefined
   */
  findRenderer(block: MessageBlock): BlockRenderer | undefined {
    return this.renderers.find(r => r.canRender(block))
  }

  /**
   * Get all registered renderers (for debugging)
   */
  getAllRenderers(): BlockRenderer[] {
    return [...this.renderers]
  }

  /**
   * Clear all renderers (mainly for testing)
   */
  clear(): void {
    this.renderers = []
  }
}

/**
 * Global singleton instance of the block renderer registry
 */
export const blockRendererRegistry = new BlockRendererRegistry()

/**
 * Default built-in renderers that are always available
 * These handle the standard block types
 */
export const defaultRenderers: BlockRenderer[] = [
  {
    id: 'text',
    priority: 0,
    canRender: block => block.type === 'text',
    render: () => {
      // This is a placeholder - actual rendering is handled in MixedContentView
      // because text blocks need access to annotations and theme
      return null
    },
  },
  {
    id: 'video',
    priority: 0,
    canRender: block => block.type === 'video',
    render: () => {
      return null // Handled in MixedContentView
    },
  },
  {
    id: 'image',
    priority: 0,
    canRender: block => block.type === 'image',
    render: () => {
      return null // Handled in MixedContentView
    },
  },
]

/**
 * Initialize the registry with default renderers
 */
export function initializeDefaultRenderers(): void {
  defaultRenderers.forEach(renderer => {
    // Only register if not already registered
    if (!blockRendererRegistry.getAllRenderers().find(r => r.id === renderer.id)) {
      blockRendererRegistry.register(renderer)
    }
  })
}
