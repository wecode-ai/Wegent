// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * useKnowledgeUrlSync - Hook for syncing knowledge page state with URL.
 *
 * Handles initial KB/group selection from URL params or virtual URL paths,
 * and provides helpers to update the URL when navigation changes.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import { buildKbUrl, parseKbUrl } from '@/utils/knowledgeUrl'
import type { KnowledgeBase } from '@/types/knowledge'

interface UseKnowledgeUrlSyncParams {
  initialKbNamespace?: string
  initialKbName?: string
  allKnowledgeBases: KnowledgeBase[]
  isGroupsLoading: boolean
  selectKb: (kb: KnowledgeBase) => void
  selectGroup: (groupId: string) => void
  selectDingtalk: () => void
  clearSelection: () => void
}

export function useKnowledgeUrlSync({
  initialKbNamespace,
  initialKbName,
  allKnowledgeBases,
  isGroupsLoading,
  selectKb,
  selectGroup,
  selectDingtalk,
  clearSelection,
}: UseKnowledgeUrlSyncParams) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [initialUrlSyncDone, setInitialUrlSyncDone] = useState(false)
  const lastSyncedUrlRef = useRef<string | null>(null)

  // Keep sidebar selection in sync with the current URL.
  // This handles initial load, client-side history updates, and browser back/forward.
  useEffect(() => {
    if (isGroupsLoading) return

    const currentUrlKey = `${pathname}?${searchParams.toString()}`
    if (lastSyncedUrlRef.current === currentUrlKey && initialUrlSyncDone) return

    const parsedKbUrl = pathname ? parseKbUrl(pathname) : null

    if (parsedKbUrl) {
      let found: KnowledgeBase | undefined
      if (parsedKbUrl.namespace) {
        found = allKnowledgeBases.find(
          kb =>
            kb.name.toLowerCase() === parsedKbUrl.kbName.toLowerCase() &&
            kb.namespace.toLowerCase() === parsedKbUrl.namespace.toLowerCase()
        )
      } else {
        found = allKnowledgeBases.find(
          kb => kb.name.toLowerCase() === parsedKbUrl.kbName.toLowerCase()
        )
      }
      if (found) {
        selectKb(found)
      } else {
        clearSelection()
      }
      lastSyncedUrlRef.current = currentUrlKey
      setInitialUrlSyncDone(true)
      return
    }

    const kbParam = searchParams.get('kb')
    const groupParam = searchParams.get('group')

    if (kbParam) {
      const kbId = parseInt(kbParam, 10)
      if (!isNaN(kbId)) {
        const found = allKnowledgeBases.find(kb => kb.id === kbId)
        if (found) {
          selectKb(found)
        }
      }
    } else if (groupParam === 'dingtalk') {
      selectDingtalk()
    } else if (groupParam) {
      selectGroup(groupParam)
    } else {
      clearSelection()
    }
    lastSyncedUrlRef.current = currentUrlKey
    setInitialUrlSyncDone(true)
  }, [
    pathname,
    searchParams,
    allKnowledgeBases,
    isGroupsLoading,
    selectKb,
    selectGroup,
    selectDingtalk,
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
      kb: { name: string; namespace: string },
      allKbsWithGroupInfo: Array<{ name: string; namespace: string; group_type?: string }>
    ) => {
      const kbWithInfo = allKbsWithGroupInfo.find(
        k => k.name === kb.name && k.namespace === kb.namespace
      )
      const isOrganization = kbWithInfo?.group_type === 'organization'
      const kbPath = buildKbUrl(kb.namespace, kb.name, isOrganization)
      window.history.pushState({}, '', kbPath)
    },
    []
  )

  return { initialUrlSyncDone, updateUrlParams, navigateToKbViaHistory }
}
