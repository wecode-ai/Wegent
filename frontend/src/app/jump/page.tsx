'use client'

import { useEffect, useState, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'

/**
 * Jump page for DingTalk notification redirects
 *
 * IMPORTANT: This page must NOT trigger DingTalk authentication redirect.
 * It's designed to detect User-Agent and redirect to the appropriate URL:
 * - DingTalk browser (mobile) -> outer URL (external access)
 * - PC browser -> inner URL (internal access)
 *
 * URL format: /jump?target={taskType}&taskId={taskId}&inner={innerUrl}&outer={outerUrl}
 */

function JumpContent() {
  const searchParams = useSearchParams()
  const [status, setStatus] = useState<'detecting' | 'redirecting' | 'error'>('detecting')
  const [errorMessage, setErrorMessage] = useState<string>('')

  useEffect(() => {
    // Perform redirect immediately without any auth checks
    const target = searchParams.get('target') // e.g., 'chat' or 'code'
    const taskId = searchParams.get('taskId')
    const innerUrl = searchParams.get('inner') // internal URL (e.g., http://internal.example.com)
    const outerUrl = searchParams.get('outer') // external URL (e.g., https://external.example.com)

    if (!target || !taskId) {
      setStatus('error')
      setErrorMessage('Missing required parameters: target or taskId')
      return
    }

    // Detect if running in DingTalk browser by checking User-Agent
    const userAgent = navigator.userAgent.toLowerCase()
    const isDingTalk = userAgent.includes('dingtalk')

    // Determine base URL based on browser type
    // DingTalk mobile -> use outer URL (external access)
    // PC browser -> use inner URL (internal access)
    let baseUrl: string

    if (isDingTalk) {
      // DingTalk browser - use outer URL for external access
      baseUrl = outerUrl || window.location.origin
    } else {
      // PC browser - use inner URL for internal access
      baseUrl = innerUrl || window.location.origin
    }

    // Build final redirect URL
    const redirectUrl = `${baseUrl}/${target}?taskId=${taskId}`

    setStatus('redirecting')

    // Redirect to the appropriate URL immediately
    // Use window.location.replace to prevent back button issues
    window.location.replace(redirectUrl)
  }, [searchParams])

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="text-center">
        {status === 'detecting' && (
          <>
            <div className="mb-4 h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto"></div>
            <p className="text-gray-600">正在检测环境...</p>
          </>
        )}
        {status === 'redirecting' && (
          <>
            <div className="mb-4 h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto"></div>
            <p className="text-gray-600">正在跳转...</p>
          </>
        )}
        {status === 'error' && (
          <>
            <div className="mb-4 text-red-500">
              <svg
                className="mx-auto h-12 w-12"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
            </div>
            <p className="text-red-600">{errorMessage}</p>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * Loading fallback for Suspense
 */
function JumpLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="text-center">
        <div className="mb-4 h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto"></div>
        <p className="text-gray-600">正在加载...</p>
      </div>
    </div>
  )
}

/**
 * Main export - wrapped in Suspense for useSearchParams
 * This page is intentionally simple and does NOT use any auth hooks
 * to avoid triggering DingTalk authentication redirect
 */
export default function JumpPage() {
  return (
    <Suspense fallback={<JumpLoading />}>
      <JumpContent />
    </Suspense>
  )
}
