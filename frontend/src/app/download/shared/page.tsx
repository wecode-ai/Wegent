'use client'

import { useEffect, useState, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import {
  FileIcon,
  Download,
  Loader2,
  AlertCircle,
  FileText,
  Image,
  Video,
  Music,
  X,
  ZoomIn,
  ZoomOut,
  RotateCw,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { UserProvider, useUser } from '@/features/common/UserContext'
import { getToken } from '@/apis/user'
import * as XLSX from 'xlsx'

const API_BASE_URL = ''

interface AttachmentInfo {
  id: number
  filename: string
  mime_type: string
  file_size?: number
  fileData?: Blob
}

// Excel 数据类型
interface ExcelSheet {
  name: string
  data: (string | number | boolean | null)[][]
}

type PreviewType = 'image' | 'pdf' | 'text' | 'video' | 'audio' | 'office' | 'unknown'

// 判断文件预览类型
function getPreviewType(mimeType: string, filename: string): PreviewType {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType === 'application/pdf') return 'pdf'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType.startsWith('audio/')) return 'audio'
  if (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/javascript' ||
    mimeType === 'application/typescript' ||
    mimeType === 'application/xml' ||
    filename.match(
      /\.(txt|md|json|js|ts|jsx|tsx|py|java|go|rs|cpp|c|h|hpp|css|scss|less|html|htm|xml|yaml|yml|sh|bash|zsh|ps1|sql|log)$/i
    )
  ) {
    return 'text'
  }
  if (
    mimeType.includes('officedocument') ||
    mimeType.includes('msword') ||
    mimeType.includes('ms-excel') ||
    mimeType.includes('ms-powerpoint') ||
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ) {
    return 'office'
  }
  return 'unknown'
}

// 格式化文件大小
function formatFileSize(bytes?: number): string {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

// 获取文件图标
function FileTypeIcon({
  mimeType,
  filename,
  className = 'w-6 h-6',
}: {
  mimeType: string
  filename: string
  className?: string
}) {
  const type = getPreviewType(mimeType, filename)
  const iconClass = `${className} text-primary`

  switch (type) {
    case 'image':
      return <Image className={iconClass} />
    case 'pdf':
    case 'text':
      return <FileText className={iconClass} />
    case 'video':
      return <Video className={iconClass} />
    case 'audio':
      return <Music className={iconClass} />
    default:
      return <FileIcon className={iconClass} />
  }
}

// 图片预览组件
function ImagePreview({ url, filename }: { url: string; filename: string }) {
  const [scale, setScale] = useState(1)
  const [rotation, setRotation] = useState(0)

  return (
    <div className="flex flex-col h-full">
      {/* 图片工具栏 */}
      <div className="flex items-center justify-center gap-2 p-2 bg-surface dark:bg-gray-800 border-b border-border dark:border-gray-700">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setScale(s => Math.max(0.1, s - 0.1))}
          title="缩小"
        >
          <ZoomOut className="w-4 h-4" />
        </Button>
        <span className="text-sm text-text-secondary min-w-[60px] text-center">
          {Math.round(scale * 100)}%
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setScale(s => Math.min(3, s + 0.1))}
          title="放大"
        >
          <ZoomIn className="w-4 h-4" />
        </Button>
        <div className="w-px h-6 bg-border dark:bg-gray-600 mx-2" />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setRotation(r => (r + 90) % 360)}
          title="旋转"
        >
          <RotateCw className="w-4 h-4" />
        </Button>
      </div>

      {/* 图片显示区域 */}
      <div className="flex-1 overflow-auto bg-gray-100 dark:bg-gray-900 flex items-center justify-center p-4">
        <img
          src={url}
          alt={filename}
          className="max-w-full max-h-full object-contain transition-transform duration-200"
          style={{
            transform: `scale(${scale}) rotate(${rotation}deg)`,
          }}
        />
      </div>
    </div>
  )
}

// PDF 预览组件
function PDFPreview({ url, filename }: { url: string; filename: string }) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 bg-gray-100 dark:bg-gray-900">
        <iframe src={url} className="w-full h-full border-0" title={filename} />
      </div>
    </div>
  )
}

// 文本预览组件
function TextPreview({ content, filename }: { content: string; filename: string }) {
  // 尝试检测是否是代码文件
  const isCode = filename.match(
    /\.(js|ts|jsx|tsx|py|java|go|rs|cpp|c|h|hpp|css|scss|less|html|htm|xml|json|yaml|yml|sh|bash|zsh|ps1|sql)$/i
  )

  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-900">
      <div className="flex-1 overflow-auto p-4">
        {isCode ? (
          <pre className="font-mono text-sm text-text-primary dark:text-gray-200 whitespace-pre-wrap break-all">
            {content}
          </pre>
        ) : (
          <div className="text-text-primary dark:text-gray-200 whitespace-pre-wrap break-all leading-relaxed">
            {content}
          </div>
        )}
      </div>
    </div>
  )
}

// 视频预览组件
function VideoPreview({ url }: { url: string }) {
  return (
    <div className="flex flex-col h-full bg-black">
      <div className="flex-1 flex items-center justify-center">
        <video src={url} controls className="max-w-full max-h-full" controlsList="nodownload">
          您的浏览器不支持视频播放
        </video>
      </div>
    </div>
  )
}

// 音频预览组件
function AudioPreview({ url, filename }: { url: string; filename: string }) {
  return (
    <div className="flex flex-col h-full bg-surface items-center justify-center p-8">
      <Music className="w-24 h-24 text-primary/50 mb-6" />
      <h3 className="text-lg font-medium mb-4 text-center break-all">{filename}</h3>
      <audio src={url} controls className="w-full max-w-md" controlsList="nodownload">
        您的浏览器不支持音频播放
      </audio>
    </div>
  )
}

// 判断 Office 文档类型
function getOfficeType(filename: string): 'excel' | 'word' | 'powerpoint' {
  const ext = filename.toLowerCase()
  if (ext.match(/\.(xlsx|xls|csv)$/)) return 'excel'
  if (ext.match(/\.(pptx|ppt)$/)) return 'powerpoint'
  return 'word'
}

// 使用 SheetJS 解析 Excel 文件
async function parseExcelFile(blob: Blob): Promise<ExcelSheet[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = e => {
      try {
        const data = e.target?.result
        if (!data) {
          reject(new Error('无法读取文件'))
          return
        }

        const workbook = XLSX.read(data, { type: 'array' })
        const sheets: ExcelSheet[] = []

        for (const sheetName of workbook.SheetNames) {
          const worksheet = workbook.Sheets[sheetName]
          // 转换为二维数组，保留空单元格
          const jsonData = XLSX.utils.sheet_to_json(worksheet, {
            header: 1,
            defval: '',
            blankrows: false,
          }) as (string | number | boolean | null)[][]

          sheets.push({
            name: sheetName,
            data: jsonData,
          })
        }

        resolve(sheets)
      } catch (error) {
        reject(error)
      }
    }
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsArrayBuffer(blob)
  })
}

// Excel 表格预览组件
function ExcelPreview({ sheets, filename }: { sheets: ExcelSheet[]; filename: string }) {
  const [activeSheet, setActiveSheet] = useState(0)

  if (sheets.length === 0) {
    return (
      <div className="flex flex-col h-full bg-white dark:bg-gray-900 items-center justify-center">
        <div className="text-text-secondary">无法解析表格内容</div>
      </div>
    )
  }

  const currentSheet = sheets[activeSheet]

  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-900">
      {/* Sheet 切换标签 */}
      {sheets.length > 1 && (
        <div className="flex items-center gap-1 p-2 bg-surface dark:bg-gray-800 border-b border-border dark:border-gray-700 overflow-x-auto">
          {sheets.map((sheet, index) => (
            <button
              key={index}
              onClick={() => setActiveSheet(index)}
              className={`px-4 py-2 text-sm font-medium rounded-md transition-colors whitespace-nowrap ${
                index === activeSheet
                  ? 'bg-white dark:bg-gray-700 text-text-primary dark:text-white shadow-sm border border-border dark:border-gray-600'
                  : 'text-text-secondary hover:text-text-primary hover:bg-white/50 dark:hover:bg-gray-700/50'
              }`}
            >
              {sheet.name}
            </button>
          ))}
        </div>
      )}

      {/* 表格内容 */}
      <div className="flex-1 overflow-auto">
        <div className="inline-block min-w-full">
          <table className="border-collapse text-sm">
            <tbody>
              {currentSheet.data.map((row, rowIndex) => (
                <tr key={rowIndex} className={rowIndex === 0 ? 'bg-surface dark:bg-gray-800' : ''}>
                  {/* 行号 */}
                  <td className="sticky left-0 w-12 px-2 py-2 text-right text-xs text-text-secondary bg-inherit dark:bg-gray-800 border-r border-b border-border dark:border-gray-700 select-none">
                    {rowIndex + 1}
                  </td>
                  {row.map((cell, cellIndex) => {
                    const isHeader = rowIndex === 0
                    const cellValue = cell !== null && cell !== undefined ? String(cell) : ''

                    return (
                      <td
                        key={cellIndex}
                        className={`px-3 py-2 border-r border-b border-border dark:border-gray-700 min-w-[80px] max-w-[400px] ${
                          isHeader
                            ? 'font-semibold text-text-primary dark:text-white bg-surface dark:bg-gray-800'
                            : 'text-text-primary dark:text-gray-200 bg-white dark:bg-gray-900'
                        }`}
                        title={cellValue}
                      >
                        <div className="truncate">{cellValue}</div>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 底部信息 */}
      <div className="px-4 py-2 bg-surface dark:bg-gray-800 border-t border-border dark:border-gray-700 text-xs text-text-secondary">
        {filename} · {currentSheet.name} · {currentSheet.data.length} 行
      </div>
    </div>
  )
}

// Word/PPT 文本预览组件
function WordPreview({ content }: { content: string; filename?: string }) {
  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-900">
      <div className="flex-1 overflow-auto p-4">
        <div className="max-w-3xl mx-auto">
          <div className="text-text-primary dark:text-gray-200 whitespace-pre-wrap break-all leading-relaxed">
            {content}
          </div>
        </div>
      </div>
    </div>
  )
}

// 未知文件类型预览
function UnknownPreview({ filename, fileSize }: { filename: string; fileSize?: number }) {
  return (
    <div className="flex flex-col h-full bg-surface items-center justify-center p-8">
      <FileIcon className="w-24 h-24 text-primary/50 mb-6" />
      <h3 className="text-lg font-medium mb-2 text-center break-all">{filename}</h3>
      {fileSize && <p className="text-sm text-text-secondary mb-6">{formatFileSize(fileSize)}</p>}
      <p className="text-text-secondary text-sm">该文件类型暂不支持预览，请下载查看</p>
    </div>
  )
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
  const [fileContent, setFileContent] = useState<string>('')
  const [fileUrl, setFileUrl] = useState<string>('')
  const [excelSheets, setExcelSheets] = useState<ExcelSheet[]>([])

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
      if (fileUrl) {
        URL.revokeObjectURL(fileUrl)
      }
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
      const previewType = getPreviewType(contentType, filename)

      setAttachmentInfo({
        id: 0,
        filename,
        mime_type: contentType,
        file_size: contentLength ? parseInt(contentLength) : blob.size,
        fileData: blob,
      })

      // 根据类型处理文件内容
      if (previewType === 'text' || previewType === 'office') {
        // 对于 Excel 文件，使用 SheetJS 解析
        const officeType = getOfficeType(filename)
        if (officeType === 'excel') {
          try {
            const sheets = await parseExcelFile(blob)
            setExcelSheets(sheets)
          } catch (_e) {
            // 如果解析失败，回退到文本模式
            const text = await blob.text()
            setFileContent(text)
          }
        } else {
          // Word/PPT 使用文本内容
          const text = await blob.text()
          setFileContent(text)
        }
      }

      // 为支持的类型创建 URL
      if (['image', 'pdf', 'video', 'audio'].includes(previewType)) {
        const url = URL.createObjectURL(blob)
        setFileUrl(url)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  const downloadFile = async () => {
    if (!attachmentInfo?.fileData) return

    try {
      setDownloading(true)
      const url = URL.createObjectURL(attachmentInfo.fileData)
      const link = document.createElement('a')
      link.href = url
      link.download = attachmentInfo.filename
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('Download failed:', err)
    } finally {
      setDownloading(false)
    }
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

  const previewType = getPreviewType(attachmentInfo.mime_type, attachmentInfo.filename)

  return (
    <div className="min-h-screen bg-white dark:bg-gray-900 flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-border dark:border-gray-700 bg-white dark:bg-gray-900 sticky top-0 z-10">
        <div className="flex items-center gap-3 min-w-0">
          <FileTypeIcon
            mimeType={attachmentInfo.mime_type}
            filename={attachmentInfo.filename}
            className="w-6 h-6 flex-shrink-0"
          />
          <div className="min-w-0">
            <h1 className="font-medium text-text-primary truncate max-w-[200px] sm:max-w-[300px] md:max-w-[500px]">
              {attachmentInfo.filename}
            </h1>
            <p className="text-xs text-text-secondary">
              {formatFileSize(attachmentInfo.file_size)}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <Button variant="primary" size="sm" onClick={downloadFile} disabled={downloading}>
            {downloading ? (
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
            ) : (
              <Download className="w-4 h-4 mr-2" />
            )}
            下载
          </Button>
          <Button variant="ghost" size="icon" onClick={() => router.push('/chat')} title="关闭">
            <X className="w-5 h-5" />
          </Button>
        </div>
      </header>

      {/* Preview Area */}
      <main className="flex-1 overflow-hidden">
        {previewType === 'image' && fileUrl && (
          <ImagePreview url={fileUrl} filename={attachmentInfo.filename} />
        )}

        {previewType === 'pdf' && fileUrl && (
          <PDFPreview url={fileUrl} filename={attachmentInfo.filename} />
        )}

        {previewType === 'text' && (
          <TextPreview content={fileContent} filename={attachmentInfo.filename} />
        )}

        {previewType === 'video' && fileUrl && <VideoPreview url={fileUrl} />}

        {previewType === 'audio' && fileUrl && (
          <AudioPreview url={fileUrl} filename={attachmentInfo.filename} />
        )}

        {previewType === 'office' &&
          (() => {
            const officeType = getOfficeType(attachmentInfo.filename)
            if (officeType === 'excel') {
              return <ExcelPreview sheets={excelSheets} filename={attachmentInfo.filename} />
            }
            // Word 和 PowerPoint 使用文本预览
            return <WordPreview content={fileContent} filename={attachmentInfo.filename} />
          })()}

        {previewType === 'unknown' && (
          <UnknownPreview filename={attachmentInfo.filename} fileSize={attachmentInfo.file_size} />
        )}
      </main>
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
