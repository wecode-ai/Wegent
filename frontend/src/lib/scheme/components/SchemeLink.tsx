// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useUser } from '@/features/common/UserContext'
import { handleSchemeURL } from '@/lib/scheme'

/**
 * Props for SchemeLink component
 */
export interface SchemeLinkProps {
  /** The scheme URL (e.g., wegent://open/chat) */
  href: string
  /** Link content */
  children?: React.ReactNode
  /** Optional CSS class name */
  className?: string
}

/**
 * A component for rendering clickable scheme URLs (wegent://*).
 *
 * This component handles click events and dispatches them to the scheme system,
 * preventing the browser's default protocol handler from being triggered.
 *
 * @example
 * ```tsx
 * <SchemeLink href="wegent://open/chat">
 *   Open Chat
 * </SchemeLink>
 * ```
 */
export function SchemeLink({
  href,
  children,
  className = 'text-primary hover:underline',
}: SchemeLinkProps) {
  const router = useRouter()
  const { user } = useUser()

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      e.preventDefault()
      handleSchemeURL(href, router, user)
    },
    [href, router, user]
  )

  return (
    <a href={href} onClick={handleClick} className={className}>
      {children}
    </a>
  )
}
