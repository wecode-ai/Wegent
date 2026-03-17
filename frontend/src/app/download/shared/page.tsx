'use client'

import { useEffect, useState, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { FileIcon, Download, Loader2, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { UserProvider, useUser } from '@/features/common/UserContext'
import { getToken } from '@/apis/user'

const API_BASE_URL = ''

interface AttachmentInfo {
  id: number
  filename: string
  mime_type: string
  file_size?: number
}

// Inner component that uses useSearchParams
function PublicDownloadContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const { user, isLoading: authLoading } = useUser()
  const [attachmentInfo, setAttachmentInfo] = useState<AttachmentInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [downloading, setDownloading] = useState(false)
  const [downloadComplete, setDownloadComplete] = useState(false)

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

    // Logged in, fetch and download
    fetchAndDownload()
  }, [isAuthenticated, authLoading, token])

  const fetchAndDownload = async () => {
    try {
      setLoading(true)
      const authToken = getToken()

      // First, try to download directly (this will also verify the token and get file info)
      await downloadFile(authToken)
    } catch (err) {
      setError(err instanceof Error ? err.message : '下载失败')
    } finally {
      setLoading(false)
    }
  }

  const downloadFile = async (authToken?: string | null) => {
    if (!token) {
      throw new Error('无效的分享链接')
    }

    try {
      setDownloading(true)

      // Fetch the file from backend using public download endpoint
      const response = await fetch(
        `${API_BASE_URL}/api/attachments/download/shared?token=${encodeURIComponent(token)}`,
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
        throw new Error('下载失败')
      }

      // Get filename from Content-Disposition header
      const contentDisposition = response.headers.get('Content-Disposition')
      let filename = 'download'
      if (contentDisposition) {
        // Try RFC 5987 encoded filename first: filename*=UTF-8''encoded_name
        const encodedMatch = contentDisposition.match(/filename\*=UTF-8''([^;"]+)/)
        if (encodedMatch) {
          filename = decodeURIComponent(encodedMatch[1])
        } else {
          // Fall back to simple filename: filename="name" or filename=name
          const simpleMatch = contentDisposition.match(/filename="([^"]+)"|filename=([^;]+)/)
          if (simpleMatch) {
            filename = simpleMatch[1] || simpleMatch[2]?.trim() || filename
          }
        }
      }

      // Extract file info from response
      const contentType = response.headers.get('Content-Type') || 'application/octet-stream'
      const contentLength = response.headers.get('Content-Length')

      setAttachmentInfo({
        id: 0, // We don't have the actual ID from public download
        filename,
        mime_type: contentType,
        file_size: contentLength ? parseInt(contentLength) : undefined,
      })

      // Create blob and download
      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      window.URL.revokeObjectURL(url)

      setDownloadComplete(true)
    } catch (err) {
      throw err
    } finally {
      setDownloading(false)
    }
  }

  if (authLoading || loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
          <p className="text-gray-600">加载中...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-xl shadow-lg p-8 max-w-md w-full text-center">
          <AlertCircle className="w-16 h-16 mx-auto text-red-500 mb-4" />
          <h1 className="text-xl font-semibold mb-2">下载失败</h1>
          <p className="text-gray-600 mb-6">{error}</p>
          <Button onClick={() => router.push('/chat')}>返回首页</Button>
        </div>
      </div>
    )
  }

  // Show downloading state
  if (downloading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-xl shadow-lg p-8 max-w-md w-full text-center">
          <div className="mb-6">
            <Loader2 className="w-20 h-20 mx-auto text-primary animate-spin" />
          </div>
          <h1 className="text-xl font-semibold mb-2">正在下载...</h1>
          {attachmentInfo && (
            <p className="text-gray-500 text-sm break-all">{attachmentInfo.filename}</p>
          )}
        </div>
      </div>
    )
  }

  // Show success state
  if (downloadComplete) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-xl shadow-lg p-8 max-w-md w-full text-center">
          <div className="mb-6">
            <FileIcon className="w-20 h-20 mx-auto text-green-500" />
          </div>
          <h1 className="text-xl font-semibold mb-2 text-green-600">下载已开始</h1>
          {attachmentInfo && (
            <>
              <p className="text-gray-500 text-sm break-all mb-4">{attachmentInfo.filename}</p>
              <p className="text-xs text-gray-400">如果下载没有自动开始，请点击下方按钮</p>
            </>
          )}
          <div className="mt-4 flex items-center justify-center gap-2">
            <Button variant="outline" onClick={() => router.push('/chat')}>
              返回首页
            </Button>
            <Button onClick={() => downloadFile(getToken())}>
              <Download className="w-4 h-4 mr-2" />
              重新下载
            </Button>
          </div>
        </div>
      </div>
    )
  }

  // Default: show file info with manual download button
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-lg p-8 max-w-md w-full text-center">
        <div className="mb-6">
          <FileIcon className="w-20 h-20 mx-auto text-primary" />
        </div>

        {attachmentInfo && (
          <>
            <h1 className="text-xl font-semibold mb-2 break-all">{attachmentInfo.filename}</h1>
            <p className="text-gray-500 text-sm mb-2">{attachmentInfo.mime_type}</p>
            {attachmentInfo.file_size && (
              <p className="text-gray-400 text-xs mb-6">
                {(attachmentInfo.file_size / 1024 / 1024).toFixed(1)} MB
              </p>
            )}
          </>
        )}

        <Button size="lg" className="w-full" onClick={() => downloadFile(getToken())}>
          <Download className="w-5 h-5 mr-2" />
          下载文件
        </Button>
      </div>
    </div>
  )
}

// Main export with UserProvider wrapper and Suspense
export default function PublicAttachmentDownloadPage() {
  return (
    <UserProvider>
      <Suspense
        fallback={
          <div className="min-h-screen bg-gray-50 flex items-center justify-center">
            <div className="flex flex-col items-center gap-4">
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
              <p className="text-gray-600">加载中...</p>
            </div>
          </div>
        }
      >
        <PublicDownloadContent />
      </Suspense>
    </UserProvider>
  )
}
