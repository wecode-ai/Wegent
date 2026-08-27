// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useState, type ComponentType } from 'react'

export const OPEN_TASK_RIGHT_PANEL_EVENT = 'wegent:open-task-right-panel'

export interface TaskRightPanelRequest<T = unknown> {
  panelType: string
  panelProps: T
}

export interface TaskRightPanelComponentProps<T = unknown> {
  panelProps: T
  onClose: () => void
  embedded: boolean
}

interface TaskRightPanelRendererProps {
  request: TaskRightPanelRequest
  onClose: () => void
  embedded?: boolean
}

const panelRegistry: Record<string, ComponentType<TaskRightPanelComponentProps>> = {}

export function registerTaskRightPanel<T>(
  panelType: string,
  component: ComponentType<TaskRightPanelComponentProps<T>>
): void {
  panelRegistry[panelType] = component as ComponentType<TaskRightPanelComponentProps>
}

export function hasTaskRightPanel(panelType: string): boolean {
  return panelType in panelRegistry
}

export function openTaskRightPanel<T>(request: TaskRightPanelRequest<T>): void {
  window.dispatchEvent(
    new CustomEvent<TaskRightPanelRequest<T>>(OPEN_TASK_RIGHT_PANEL_EVENT, {
      detail: request,
    })
  )
}

export function useTaskRightPanel() {
  const [request, setRequest] = useState<TaskRightPanelRequest | null>(null)

  useEffect(() => {
    const handleOpen = (event: Event) => {
      const detail = (event as CustomEvent<TaskRightPanelRequest>).detail
      if (!detail || !hasTaskRightPanel(detail.panelType)) return
      setRequest(detail)
    }

    window.addEventListener(OPEN_TASK_RIGHT_PANEL_EVENT, handleOpen)
    return () => window.removeEventListener(OPEN_TASK_RIGHT_PANEL_EVENT, handleOpen)
  }, [])

  const close = useCallback(() => setRequest(null), [])

  return { request, close }
}

export function TaskRightPanelRenderer({
  request,
  onClose,
  embedded = true,
}: TaskRightPanelRendererProps) {
  const Component = panelRegistry[request.panelType]
  if (!Component) return null

  return <Component panelProps={request.panelProps} onClose={onClose} embedded={embedded} />
}
