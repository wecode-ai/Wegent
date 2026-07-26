// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { knowledgeArtifactApi } from '@/apis/knowledge-artifacts'
import type { KnowledgeArtifact, KnowledgeArtifactCreate } from '@/types/knowledge-artifact'

const POLL_INTERVAL_MS = 5000

export function useKnowledgeArtifacts(knowledgeBaseId: number) {
  const [items, setItems] = useState<KnowledgeArtifact[]>([])
  const [canManage, setCanManage] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const mountedRef = useRef(true)

  const refresh = useCallback(
    async (showLoading = false) => {
      if (showLoading) setIsLoading(true)
      try {
        const response = await knowledgeArtifactApi.list(knowledgeBaseId)
        if (!mountedRef.current) return
        setItems(response.items)
        setCanManage(response.can_manage)
        setError(null)
      } catch (nextError) {
        if (mountedRef.current) {
          setError(nextError instanceof Error ? nextError : new Error(String(nextError)))
        }
      } finally {
        if (mountedRef.current) setIsLoading(false)
      }
    },
    [knowledgeBaseId]
  )

  useEffect(() => {
    mountedRef.current = true
    setItems([])
    setCanManage(false)
    setError(null)
    void refresh(true)
    return () => {
      mountedRef.current = false
    }
  }, [refresh])

  const hasActiveArtifact = items.some(
    artifact => artifact.status === 'queued' || artifact.status === 'running'
  )

  useEffect(() => {
    if (!hasActiveArtifact) return
    const timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [hasActiveArtifact, refresh])

  const create = useCallback(
    async (request: KnowledgeArtifactCreate) => {
      const artifact = await knowledgeArtifactApi.create(knowledgeBaseId, request)
      setItems(current => [artifact, ...current])
      return artifact
    },
    [knowledgeBaseId]
  )

  const rename = useCallback(
    async (artifactId: string, title: string) => {
      const artifact = await knowledgeArtifactApi.rename(knowledgeBaseId, artifactId, title)
      setItems(current =>
        current.map(item => (item.artifact_id === artifact.artifact_id ? artifact : item))
      )
      return artifact
    },
    [knowledgeBaseId]
  )

  const retry = useCallback(
    async (artifactId: string) => {
      const artifact = await knowledgeArtifactApi.retry(knowledgeBaseId, artifactId)
      setItems(current =>
        current.map(item => (item.artifact_id === artifact.artifact_id ? artifact : item))
      )
      return artifact
    },
    [knowledgeBaseId]
  )

  const remove = useCallback(
    async (artifactId: string) => {
      await knowledgeArtifactApi.delete(knowledgeBaseId, artifactId)
      setItems(current => current.filter(item => item.artifact_id !== artifactId))
    },
    [knowledgeBaseId]
  )

  return {
    items,
    canManage,
    isLoading,
    error,
    create,
    rename,
    retry,
    remove,
    refresh,
  }
}
