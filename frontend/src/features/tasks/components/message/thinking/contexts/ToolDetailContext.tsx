// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { createContext, useContext, useState, useCallback } from 'react'
import type { ToolRendererProps } from '../types'

interface ToolDetailContextValue {
  selectedTool: ToolRendererProps['tool'] | null
  setSelectedTool: (tool: ToolRendererProps['tool'] | null) => void
  isToolDetailOpen: boolean
  isInDetailPanel: boolean // New: indicates if renderer is in detail panel
}

const ToolDetailContext = createContext<ToolDetailContextValue | undefined>(undefined)

export function ToolDetailProvider({ children }: { children: React.ReactNode }) {
  const [selectedTool, setSelectedToolState] = useState<ToolRendererProps['tool'] | null>(null)

  const setSelectedTool = useCallback((tool: ToolRendererProps['tool'] | null) => {
    setSelectedToolState(tool)
  }, [])

  const isToolDetailOpen = selectedTool !== null
  const isInDetailPanel = false // Default context is not in detail panel

  return (
    <ToolDetailContext.Provider
      value={{ selectedTool, setSelectedTool, isToolDetailOpen, isInDetailPanel }}
    >
      {children}
    </ToolDetailContext.Provider>
  )
}

/**
 * Provider for tool renderers inside detail panel - marks content as always expanded
 */
export function ToolDetailPanelContentProvider({ children }: { children: React.ReactNode }) {
  const parentContext = useContext(ToolDetailContext)
  if (!parentContext) {
    throw new Error('ToolDetailPanelContentProvider must be used within ToolDetailProvider')
  }

  return (
    <ToolDetailContext.Provider value={{ ...parentContext, isInDetailPanel: true }}>
      {children}
    </ToolDetailContext.Provider>
  )
}

export function useToolDetail() {
  const context = useContext(ToolDetailContext)
  if (!context) {
    throw new Error('useToolDetail must be used within ToolDetailProvider')
  }
  return context
}

/**
 * Hook to check if tool detail is open (for use outside of provider to control other panels)
 * Returns false if used outside provider (graceful degradation)
 */
export function useIsToolDetailOpen(): boolean {
  const context = useContext(ToolDetailContext)
  return context?.isToolDetailOpen ?? false
}

/**
 * Hook to check if renderer is inside detail panel (for auto-expand behavior)
 * Returns false if used outside provider (graceful degradation)
 */
export function useIsInDetailPanel(): boolean {
  const context = useContext(ToolDetailContext)
  return context?.isInDetailPanel ?? false
}
