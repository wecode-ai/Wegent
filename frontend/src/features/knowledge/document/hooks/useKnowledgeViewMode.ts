// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import type { KnowledgeBaseType, KnowledgeView } from '@/types/knowledge'

export const DEFAULT_KNOWLEDGE_VIEW: KnowledgeView = 'notebook'

export function isKnowledgeView(value: string | null | undefined): value is KnowledgeView {
  return value === 'documents' || value === 'notebook'
}

export function getDefaultKnowledgeView(kbType?: KnowledgeBaseType | null): KnowledgeView {
  if (kbType === 'classic') return 'documents'
  if (kbType === 'notebook') return 'notebook'
  return DEFAULT_KNOWLEDGE_VIEW
}

function readBrowserView(): string | null {
  if (typeof window === 'undefined') return null
  return new URLSearchParams(window.location.search).get('view')
}

function replaceKnowledgeViewInUrl(view: KnowledgeView) {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  url.searchParams.set('view', view)
  if (view === 'documents') {
    url.searchParams.delete('taskId')
    url.searchParams.delete('task_id')
    url.searchParams.delete('taskid')
  }
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
}

function removeTaskParamsForDocumentsView() {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  const hadTaskParam =
    url.searchParams.has('taskId') ||
    url.searchParams.has('task_id') ||
    url.searchParams.has('taskid')
  if (!hadTaskParam) return
  url.searchParams.delete('taskId')
  url.searchParams.delete('task_id')
  url.searchParams.delete('taskid')
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
}

export function useKnowledgeViewMode(kbType?: KnowledgeBaseType | null, resetKey?: unknown) {
  const searchParams = useSearchParams()
  const defaultView = useMemo(() => getDefaultKnowledgeView(kbType), [kbType])

  const resolvedView = useMemo(() => {
    void resetKey
    const viewParam = readBrowserView() ?? searchParams.get('view')
    return isKnowledgeView(viewParam) ? viewParam : defaultView
  }, [searchParams, defaultView, resetKey])

  const [currentView, setCurrentViewState] = useState<KnowledgeView>(resolvedView)

  useEffect(() => {
    setCurrentViewState(resolvedView)
  }, [resolvedView])

  useEffect(() => {
    if (currentView === 'documents') {
      removeTaskParamsForDocumentsView()
    }
  }, [currentView])

  const setCurrentView = useCallback((view: KnowledgeView) => {
    setCurrentViewState(view)
    replaceKnowledgeViewInUrl(view)
  }, [])

  return {
    currentView,
    defaultView,
    setCurrentView,
  }
}
