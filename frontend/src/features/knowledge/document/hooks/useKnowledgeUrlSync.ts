// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * useKnowledgeUrlSync - Hook for syncing knowledge page state with URL.
 *
 * Handles initial KB/group selection from URL params or virtual URL paths,
 * and provides helpers to update the URL when navigation changes.
 */

import { useState, useEffect, useCallback } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { buildKbUrl } from '@/utils/knowledgeUrl'
import type { KnowledgeBase } from '@/types/knowledge'

interface UseKnowledgeUrlSyncParams {
  initialKbNamespace?: string
  initialKbName?: string
  allKnowledgeBases: KnowledgeBase[]
  isGroupsLoading: boolean
  selectKb: (kb: KnowledgeBase) => void
  selectGroup: (groupId: string) => void
  selectDingtalk: () => void
}

export function useKnowledgeUrlSync({
  initialKbNamespace,
  initialKbName,
  allKnowledgeBases,
  isGroupsLoading,
  selectKb,
  selectGroup,
  selectDingtalk,
}: UseKnowledgeUrlSyncParams) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [initialUrlSyncDone, setInitialUrlSyncDone] = useState(false)

  // Sync selected KB or group from URL parameter on initial load only
  useEffect(() => {
    if (initialUrlSyncDone) return
    if (isGroupsLoading) return

    if (initialKbName) {
      let found: KnowledgeBase | undefined
      if (initialKbNamespace) {
        found = allKnowledgeBases.find(
          kb =>
            kb.name.toLowerCase() === initialKbName.toLowerCase() &&
            kb.namespace.toLowerCase() === initialKbNamespace.toLowerCase()
        )
      } else {
        found = allKnowledgeBases.find(kb => kb.name.toLowerCase() === initialKbName.toLowerCase())
      }
      if (found) {
        selectKb(found)
      }
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
    }
    setInitialUrlSyncDone(true)
  }, [
    searchParams,
    allKnowledgeBases,
    isGroupsLoading,
    selectKb,
    selectGroup,
    selectDingtalk,
    initialKbNamespace,
    initialKbName,
    initialUrlSyncDone,
  ])

  const updateUrlParams = useCallback(
    (params: { kb?: number | null; group?: string | null }) => {
      if (params.kb !== undefined && params.kb !== null) return

      if (initialKbName !== undefined) {
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
    [router, searchParams, initialKbName]
  )

  const navigateToKb = useCallback(
    (
      kb: { name: string; namespace: string },
      allKbsWithGroupInfo: Array<{ name: string; namespace: string; group_type?: string }>
    ) => {
      const kbWithInfo = allKbsWithGroupInfo.find(
        k => k.name === kb.name && k.namespace === kb.namespace
      )
      const isOrganization = kbWithInfo?.group_type === 'organization'
      const kbPath = buildKbUrl(kb.namespace, kb.name, isOrganization)
      router.push(kbPath)
    },
    [router]
  )

  return { initialUrlSyncDone, updateUrlParams, navigateToKb }
}
