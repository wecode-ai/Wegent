// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * useKnowledgeUrlSync - Hook for syncing knowledge page state with URL.
 *
 * Handles initial KB/group selection from URL params or virtual URL paths,
 * and provides helpers to update the URL when navigation changes.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import {
  buildKbUrl,
  getCanonicalKbUrl,
  parseKbUrl,
  parseKnowledgeBaseId,
  resolveKbByVirtualPath,
} from '@/utils/knowledgeUrl'
import type { KnowledgeBase } from '@/types/knowledge'

interface UseKnowledgeUrlSyncParams {
  scopeKey?: string
  initialKbNamespace?: string
  initialKbName?: string
  organizationKnowledgeBases: KnowledgeBase[]
  hasLoadError?: boolean
  allKnowledgeBases: KnowledgeBase[]
  isGroupsLoading: boolean
  selectKb: (kb: KnowledgeBase) => void
  selectGroup: (groupId: string) => void
  selectGroups: () => void
  selectSourceView: (sourceViewId: string) => void
  clearSelection: () => void
}

export function useKnowledgeUrlSync({
  scopeKey,
  initialKbNamespace,
  initialKbName,
  allKnowledgeBases,
  organizationKnowledgeBases,
  hasLoadError,
  isGroupsLoading,
  selectKb,
  selectGroup,
  selectGroups,
  selectSourceView,
  clearSelection,
}: UseKnowledgeUrlSyncParams) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [initialUrlSyncDone, setInitialUrlSyncDone] = useState(false)
  const lastSyncedUrlRef = useRef<string | null>(null)
  const requestedKbId = searchParams.get('kb')
  const routeKey = JSON.stringify([scopeKey, pathname, requestedKbId])
  const [lastResolved, setLastResolved] = useState<{ routeKey: string; id: number } | null>(null)
  const retainedKbId = lastResolved?.routeKey === routeKey ? lastResolved.id : undefined

  const parsedKbUrl = useMemo(() => (pathname ? parseKbUrl(pathname) : null), [pathname])
  const kbResolution = useMemo(
    () =>
      parsedKbUrl
        ? resolveKbByVirtualPath({
            allKnowledgeBases,
            organizationKnowledgeBases,
            namespace: parsedKbUrl.namespace,
            name: parsedKbUrl.kbName,
            knowledgeBaseId: requestedKbId,
            isLoading: isGroupsLoading,
            hasError: hasLoadError,
          })
        : null,
    [
      parsedKbUrl,
      requestedKbId,
      allKnowledgeBases,
      organizationKnowledgeBases,
      isGroupsLoading,
      hasLoadError,
    ]
  )

  useEffect(() => {
    if (kbResolution?.status !== 'resolved' || !parsedKbUrl) return
    const canonicalUrl = getCanonicalKbUrl(
      kbResolution.knowledgeBase,
      parsedKbUrl,
      searchParams.toString()
    )
    if (canonicalUrl) window.history.replaceState({}, '', canonicalUrl)
  }, [kbResolution, parsedKbUrl, searchParams])

  // Keep sidebar selection in sync with the current URL.
  // This handles initial load, client-side history updates, and browser back/forward.
  useEffect(() => {
    if (isGroupsLoading) return

    // Exclude taskId-related params so that adding/removing taskId doesn't trigger re-sync
    // (which would call clearSelection and lose the current KB selection)
    // Support all three param formats for backward compatibility with existing URLs
    const navParams = new URLSearchParams(searchParams.toString())
    navParams.delete('taskId')
    navParams.delete('task_id')
    navParams.delete('taskid')
    const navUrlKey = `${scopeKey ?? ''}:${pathname}?${navParams.toString()}`
    if (kbResolution) {
      if (kbResolution.status === 'loading') return
      const selectionKey = `${navUrlKey}:${kbResolution.status}:${kbResolution.status === 'resolved' ? kbResolution.knowledgeBase.id : ''}`
      if (lastSyncedUrlRef.current === selectionKey) return
      if (kbResolution.status === 'resolved') {
        selectKb(kbResolution.knowledgeBase)
        setLastResolved({ routeKey, id: kbResolution.knowledgeBase.id })
      } else if (kbResolution.status !== 'error' || retainedKbId === undefined) {
        clearSelection()
      }
      lastSyncedUrlRef.current = selectionKey
      setInitialUrlSyncDone(true)
      return
    }
    if (lastSyncedUrlRef.current === navUrlKey && initialUrlSyncDone) return

    const kbParam = searchParams.get('kb')
    const groupParam = searchParams.get('group')

    if (kbParam !== null) {
      const kbId = parseKnowledgeBaseId(kbParam)
      const found = allKnowledgeBases.find(kb => kb.id === kbId)
      if (found) selectKb(found)
      else clearSelection()
    } else if (groupParam === 'all-groups') {
      selectGroups()
    } else if (groupParam?.startsWith('source:')) {
      const sourceViewId = groupParam.slice('source:'.length)
      if (sourceViewId) {
        selectSourceView(sourceViewId)
      } else {
        clearSelection()
      }
    } else if (groupParam) {
      selectGroup(groupParam)
    } else {
      clearSelection()
    }
    lastSyncedUrlRef.current = navUrlKey
    setInitialUrlSyncDone(true)
  }, [
    scopeKey,
    kbResolution,
    routeKey,
    retainedKbId,
    pathname,
    searchParams,
    allKnowledgeBases,
    isGroupsLoading,
    selectKb,
    selectGroup,
    selectGroups,
    selectSourceView,
    clearSelection,
    initialUrlSyncDone,
  ])

  const updateUrlParams = useCallback(
    (params: { kb?: number | null; group?: string | null }) => {
      if (params.kb !== undefined && params.kb !== null) return

      const isVirtualKbRoute = Boolean(
        pathname && parseKbUrl(pathname) && !pathname.startsWith('/knowledge/document/')
      )

      if (isVirtualKbRoute || initialKbName !== undefined || initialKbNamespace !== undefined) {
        const newSearchParams = new URLSearchParams()
        newSearchParams.set('type', 'document')
        if (params.group !== undefined && params.group !== null) {
          newSearchParams.set('group', params.group)
        }
        router.push(`/knowledge?${newSearchParams.toString()}`)
        return
      }

      const newSearchParams = new URLSearchParams(searchParams.toString())
      newSearchParams.set('type', 'document')
      newSearchParams.delete('kb')

      if (params.group !== undefined) {
        if (params.group === null) {
          newSearchParams.delete('group')
        } else {
          newSearchParams.set('group', params.group)
        }
      }

      router.replace(`?${newSearchParams.toString()}`, { scroll: false })
    },
    [router, searchParams, pathname, initialKbName, initialKbNamespace]
  )

  // Navigate to a KB by updating the URL via history.pushState without triggering
  // a Next.js page remount. Use this when switching KBs from the sidebar on a
  // detail page to avoid the full unmount-remount cycle that causes UI flickering.
  const navigateToKbViaHistory = useCallback(
    (
      kb: { id: number; name: string; namespace: string },
      allKbsWithGroupInfo: Array<{
        id: number
        name: string
        namespace: string
        group_type?: string
      }>
    ) => {
      const isOrganization = allKbsWithGroupInfo.some(
        k => k.id === kb.id && k.group_type === 'organization'
      )
      const kbPath = buildKbUrl(kb.namespace, kb.name, isOrganization, undefined, {
        knowledgeBaseId: kb.id,
      })
      window.history.pushState({}, '', kbPath)
    },
    []
  )

  return { initialUrlSyncDone, kbResolution, retainedKbId, updateUrlParams, navigateToKbViaHistory }
}
