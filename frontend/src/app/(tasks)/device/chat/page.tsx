// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Suspense } from 'react'
import DeviceChatPage from '@/features/device/components/DeviceChatPage'

export default function Page() {
  return (
    <Suspense
      fallback={<div className="flex items-center justify-center h-screen">Loading...</div>}
    >
      <DeviceChatPage />
    </Suspense>
  )
}
