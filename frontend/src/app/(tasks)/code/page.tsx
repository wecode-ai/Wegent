// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { buildChatCodeHref } from '@/config/coding-route'

export default function CodePage() {
  const router = useRouter()
  const searchParams = useSearchParams()

  useEffect(() => {
    router.replace(buildChatCodeHref(new URLSearchParams(searchParams.toString())))
  }, [router, searchParams])

  return null
}
