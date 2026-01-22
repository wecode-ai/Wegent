// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useRouter } from 'next/navigation'
import { useCallback } from 'react'
import { handleSchemeURL } from './handler'
import type { SchemeURL } from './types'

/**
 * React hook for handling scheme URLs
 * Provides a convenient way to navigate using scheme URLs in React components
 */
export function useSchemeURL(user?: unknown) {
  const router = useRouter()

  const navigate = useCallback(
    (url: SchemeURL | string) => {
      handleSchemeURL(url, router, user)
    },
    [router, user]
  )

  const createHandler = useCallback(
    (url: SchemeURL | string) => {
      return (e: React.MouseEvent) => {
        e.preventDefault()
        navigate(url)
      }
    },
    [navigate]
  )

  return {
    navigate,
    createHandler,
  }
}
