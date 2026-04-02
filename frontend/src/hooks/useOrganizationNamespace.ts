// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { getOrganizationNamespace } from '@/apis/knowledge'

interface UseOrganizationNamespaceOptions {
  enabled?: boolean
}

export function useOrganizationNamespace({ enabled = true }: UseOrganizationNamespaceOptions = {}) {
  const [organizationNamespace, setOrganizationNamespace] = useState<string | null>(null)
  const [loading, setLoading] = useState(enabled)

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      return
    }

    let isMounted = true

    const loadOrganizationNamespace = async () => {
      setLoading(true)
      try {
        const response = await getOrganizationNamespace()
        if (isMounted) {
          setOrganizationNamespace(response.namespace)
        }
      } catch (error) {
        console.error('Failed to load organization namespace:', error)
        if (isMounted) {
          setOrganizationNamespace(null)
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
  }, [enabled])

  return {
    organizationNamespace,
    loading,
  }
}
