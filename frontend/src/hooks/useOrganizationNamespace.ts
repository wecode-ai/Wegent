// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useState } from 'react'
import { getOrganizationNamespace } from '@/apis/knowledge'

interface UseOrganizationNamespaceOptions {
  enabled?: boolean
}

export function useOrganizationNamespace({ enabled = true }: UseOrganizationNamespaceOptions = {}) {
  const [organizationNamespace, setOrganizationNamespace] = useState<string | null>(null)
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState<Error | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  const reload = useCallback(() => {
    setReloadKey(currentKey => currentKey + 1)
  }, [])

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      setError(null)
      return
    }

    let isMounted = true

    const loadOrganizationNamespace = async () => {
      setLoading(true)
      setError(null)
      try {
        const response = await getOrganizationNamespace()
        if (isMounted) {
          setOrganizationNamespace(response.namespace)
        }
      } catch (error) {
        console.error('Failed to load organization namespace:', error)
        if (isMounted) {
          setError(
            error instanceof Error ? error : new Error('Failed to load organization namespace')
          )
        }
      } finally {
        if (isMounted) {
          setLoading(false)
        }
      }
    }

    loadOrganizationNamespace()

    return () => {
      isMounted = false
    }
  }, [enabled, reloadKey])

  return {
    organizationNamespace,
    loading,
    error,
    reload,
  }
}
