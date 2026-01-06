// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { paths } from '@/config/paths'
import { getLastTab } from '@/utils/userPreferences'

export default function Home() {
  const router = useRouter()

  useEffect(() => {
    const lastTab = getLastTab()
    if (lastTab === 'code') {
      router.replace(paths.code.getHref())
    } else if (lastTab === 'wiki') {
      router.replace(paths.wiki.getHref())
    } else {
      // Default to chat if no preference or preference is 'chat'
      router.replace(paths.chat.getHref())
    }
  }, [router])

  // Return null while redirecting
  return null
}
