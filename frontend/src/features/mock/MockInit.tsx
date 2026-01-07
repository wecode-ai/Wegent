// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState, ReactNode } from 'react'

interface MockInitProps {
  children: ReactNode
}

export default function MockInit({ children }: MockInitProps) {
  const [isMockingReady, setIsMockingReady] = useState(false)

  useEffect(() => {
    const startMocking = async () => {
      if (process.env.NEXT_PUBLIC_USE_MOCK_API === 'true') {
        try {
          const { setupWorker } = await import('msw/browser')
          const { handlers } = await import('@/apis/mocks/handlers')
          const worker = setupWorker(...handlers)
          await worker.start({
            onUnhandledRequest: 'bypass',
          })
          setIsMockingReady(true)
        } catch (error) {
          console.error('Failed to initialize mocking:', error)
          setIsMockingReady(true) // Continue even if mocking fails
        }
      } else {
        setIsMockingReady(true)
      }
    }

    // Start mocking only on the client side
    if (typeof window !== 'undefined') {
      startMocking()
    }
  }, [])

  if (!isMockingReady) {
    return null // Or a loading spinner
  }

  return <>{children}</>
}
