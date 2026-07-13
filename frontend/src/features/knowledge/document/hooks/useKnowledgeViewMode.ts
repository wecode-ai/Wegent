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

const TASK_QUERY_KEYS = ['taskId', 'task_id', 'taskid'] as const

function readBrowserView(): string | null {
  if (typeof window === 'undefined') return null
  return new URLSearchParams(window.location.search).get('view')
}

function readBrowserTaskParam(): string | null {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  for (const key of TASK_QUERY_KEYS) {
    const value = params.get(key)
    if (value) return value
  }
  return null
}

function readTaskParam(searchParams: URLSearchParams): string | null {
  const browserValue = readBrowserTaskParam()
  if (browserValue) return browserValue
  for (const key of TASK_QUERY_KEYS) {
    const value = searchParams.get(key)
    if (value) return value
  }
  return null
}

function removeTaskParams(url: URL): boolean {
  let removed = false
  for (const key of TASK_QUERY_KEYS) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key)
      removed = true
    }
  }
  return removed
}

function replaceKnowledgeViewInUrl(view: KnowledgeView) {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  url.searchParams.set('view', view)
  if (view === 'documents') {
    removeTaskParams(url)
  }
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
}

function removeTaskParamsForDocumentsView() {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  const hadTaskParam = removeTaskParams(url)
  if (!hadTaskParam) return
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
}

export function useKnowledgeViewMode(kbType?: KnowledgeBaseType | null, resetKey?: unknown) {
  const searchParams = useSearchParams()
  const defaultView = useMemo(() => getDefaultKnowledgeView(kbType), [kbType])

  const resolvedView = useMemo(() => {
    void resetKey
    const viewParam = readBrowserView() ?? searchParams.get('view')
    if (isKnowledgeView(viewParam)) return viewParam
    return readTaskParam(searchParams) ? 'notebook' : defaultView
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
