// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { Loader2, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { UserProvider, useUser } from '@/features/common/UserContext'
import { getToken } from '@/apis/user'
import { FilePreviewPage } from '@/components/common/FilePreview'

const API_BASE_URL = ''

interface AttachmentInfo {
  id: number
  filename: string
  mime_type: string
  file_size?: number
  fileData?: Blob
}

// Inner component that uses useSearchParams
function PublicDownloadContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const { user, isLoading: authLoading } = useUser()
  const [attachmentInfo, setAttachmentInfo] = useState<AttachmentInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const token = searchParams.get('token')
  const isAuthenticated = !!user

  useEffect(() => {
    // Wait for auth state to be determined
    if (authLoading) return

    if (!isAuthenticated) {
      // Not logged in, redirect to login with return URL
      const currentUrl = window.location.href
      router.push(`/login?redirect=${encodeURIComponent(currentUrl)}`)
      return
    }

    if (!token) {
      setError('无效的分享链接')
      setLoading(false)
      return
    }

    // Logged in, fetch file for preview
    fetchFileForPreview()

    // Cleanup
    return () => {
      // Blob URLs are managed by FilePreview component
    }
  }, [isAuthenticated, authLoading, token])

  const fetchFileForPreview = async () => {
    try {
      setLoading(true)
      const authToken = getToken()

      // Fetch the file from backend
      const response = await fetch(
        `${API_BASE_URL}/api/attachments/download/shared?token=${encodeURIComponent(token!)}`,
        {
          headers: {
            ...(authToken && { Authorization: `Bearer ${authToken}` }),
          },
        }
      )

      if (!response.ok) {
        if (response.status === 403) {
          throw new Error('分享链接已过期或无效')
        }
        if (response.status === 404) {
          throw new Error('附件不存在或已被删除')
        }
        throw new Error('加载失败')
      }

      // Get filename from Content-Disposition header
      const contentDisposition = response.headers.get('Content-Disposition')
      let filename = 'download'
      if (contentDisposition) {
        const encodedMatch = contentDisposition.match(/filename\*=UTF-8''([^;"]+)/)
        if (encodedMatch) {
          filename = decodeURIComponent(encodedMatch[1])
        } else {
          const simpleMatch = contentDisposition.match(/filename="([^"]+)"|filename=([^;]+)/)
          if (simpleMatch) {
            filename = simpleMatch[1] || simpleMatch[2]?.trim() || filename
          }
        }
      }

      const contentType = response.headers.get('Content-Type') || 'application/octet-stream'
      const contentLength = response.headers.get('Content-Length')

      const blob = await response.blob()

      setAttachmentInfo({
        id: 0,
        filename,
        mime_type: contentType,
        file_size: contentLength ? parseInt(contentLength) : blob.size,
        fileData: blob,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  const handleClose = () => {
    router.push('/chat')
  }

  if (authLoading || loading) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
          <p className="text-gray-600 dark:text-gray-400">加载中...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center p-4">
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-8 max-w-md w-full text-center">
          <AlertCircle className="w-16 h-16 mx-auto text-red-500 mb-4" />
          <h1 className="text-xl font-semibold mb-2 dark:text-white">加载失败</h1>
          <p className="text-gray-600 dark:text-gray-400 mb-6">{error}</p>
          <Button onClick={() => router.push('/chat')}>返回首页</Button>
        </div>
      </div>
    )
  }

  if (!attachmentInfo) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center p-4">
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-8 max-w-md w-full text-center">
          <AlertCircle className="w-16 h-16 mx-auto text-yellow-500 mb-4" />
          <h1 className="text-xl font-semibold mb-2 dark:text-white">无法加载文件</h1>
          <Button onClick={() => router.push('/chat')}>返回首页</Button>
        </div>
      </div>
    )
  }

  return (
    <div className="h-screen overflow-hidden">
      <FilePreviewPage
        fileBlob={attachmentInfo.fileData}
        filename={attachmentInfo.filename}
        mimeType={attachmentInfo.mime_type}
        fileSize={attachmentInfo.file_size}
        onClose={handleClose}
      />
    </div>
  )
}

// Main export with UserProvider wrapper and Suspense
export default function PublicAttachmentDownloadPage() {
  return (
    <UserProvider>
      <Suspense
        fallback={
          <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center">
            <div className="flex flex-col items-center gap-4">
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
              <p className="text-gray-600 dark:text-gray-400">加载中...</p>
            </div>
          </div>
        }
      >
        <PublicDownloadContent />
      </Suspense>
    </UserProvider>
  )
}
