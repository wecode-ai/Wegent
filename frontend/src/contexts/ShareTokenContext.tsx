// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { createContext, useContext } from 'react'

interface ShareTokenContextValue {
  /** Share token for public access (no login required) */
  shareToken?: string
}

const ShareTokenContext = createContext<ShareTokenContextValue>({})

export function ShareTokenProvider({
  children,
  shareToken,
}: {
  children: React.ReactNode
  shareToken?: string
}) {
  return <ShareTokenContext.Provider value={{ shareToken }}>{children}</ShareTokenContext.Provider>
}

/**
 * Hook to access share token in nested components
 *
 * Usage:
 * ```tsx
 * const { shareToken } = useShareToken()
 * ```
 */
export function useShareToken() {
  return useContext(ShareTokenContext)
}
