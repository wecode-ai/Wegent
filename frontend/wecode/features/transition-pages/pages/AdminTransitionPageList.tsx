'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Settings, Users, FileText, Copy, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/hooks/use-toast'
import { getToken } from '@/apis/user'

interface TransitionPage {
  page_id: string
  slug: string
  title: string
  status: string
  created_at: string
  updated_at: string
}

export default function AdminTransitionPageList() {
  const router = useRouter()
  const { toast } = useToast()
  const [pages, setPages] = useState<TransitionPage[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadPages()
  }, [])

  const loadPages = async () => {
    try {
      const token = getToken()
      const response = await fetch('/api/v1/transition-pages', {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      })
      if (!response.ok) {
        throw new Error('Failed to load pages')
      }
      const data = await response.json()
      setPages(data)
    } catch (error) {
      toast({
        title: '加载失败',
        description: error instanceof Error ? error.message : '未知错误',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  const handleCreate = async () => {
    try {
      const token = getToken()
      const response = await fetch('/api/v1/transition-pages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          title: '新页面',
          slug: `page-${Date.now()}`,
        }),
      })
      if (!response.ok) {
        throw new Error('Failed to create page')
      }
      const data = await response.json()
      router.push(`/admin/transition-pages/${data.page_id}`)
    } catch (error) {
      toast({
        title: '创建失败',
        description: error instanceof Error ? error.message : '未知错误',
        variant: 'destructive',
      })
    }
  }

  const getStatusBadge = (status: string) => {
    const variants: Record<string, { label: string; className: string }> = {
      draft: { label: '草稿', className: 'bg-yellow-100 text-yellow-800' },
      published: { label: '已发布', className: 'bg-green-100 text-green-800' },
      archived: { label: '已归档', className: 'bg-gray-100 text-gray-800' },
    }
    const config = variants[status] || variants.draft
    return (
      <Badge variant="secondary" className={config.className}>
        {config.label}
      </Badge>
    )
  }

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('zh-CN')
  }

  const handleCopyLink = (slug: string) => {
    const url = `${window.location.origin}/transition-pages/t/${slug}`
    navigator.clipboard.writeText(url)
    toast({
      title: '链接已复制',
      description: url,
    })
  }

  const handleOpenLink = (slug: string) => {
    window.open(`/transition-pages/t/${slug}`, '_blank')
  }

  if (loading) {
    return (
      <div className="container mx-auto py-8 px-4">
        <div className="text-center py-12">加载中...</div>
      </div>
    )
  }

  return (
    <div className="container mx-auto py-8 px-4 max-w-5xl">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">过渡页面管理</h1>
          <p className="text-sm text-gray-500 mt-1">
            创建和管理 302 跳转页面，支持个性化内容展示
          </p>
        </div>
        <Button onClick={handleCreate} className="bg-teal-600 hover:bg-teal-700">
          <Plus className="w-4 h-4 mr-2" />
          新建页面
        </Button>
      </div>

      {pages.length === 0 ? (
        <Card className="text-center py-16">
          <CardContent>
            <FileText className="w-12 h-12 text-gray-300 mx-auto mb-4" />
            <p className="text-gray-500 mb-4">暂无过渡页面</p>
            <Button
              variant="outline"
              onClick={handleCreate}
              className="border-teal-600 text-teal-600 hover:bg-teal-50"
            >
              创建第一个页面
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {pages.map((page) => (
            <Card
              key={page.page_id}
              className="hover:shadow-md transition-shadow cursor-pointer"
              onClick={() =>
                router.push(`/admin/transition-pages/${page.page_id}`)
              }
            >
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-3 mb-2">
                      <CardTitle className="text-lg">{page.title}</CardTitle>
                      {getStatusBadge(page.status)}
                    </div>
                    <CardDescription className="text-sm">
                      <span className="font-mono text-teal-600">/transition-pages/t/{page.slug}</span>
                      <span className="mx-2">·</span>
                      <span>创建于 {formatDate(page.created_at)}</span>
                    </CardDescription>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleCopyLink(page.slug)
                      }}
                      title="复制访问链接"
                    >
                      <Copy className="w-4 h-4 mr-1" />
                      复制链接
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleOpenLink(page.slug)
                      }}
                      title="打开访问页面"
                    >
                      <ExternalLink className="w-4 h-4 mr-1" />
                      访问
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation()
                        router.push(`/admin/transition-pages/${page.page_id}?tab=users`)
                      }}
                    >
                      <Users className="w-4 h-4 mr-1" />
                      用户
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation()
                        router.push(`/admin/transition-pages/${page.page_id}`)
                      }}
                    >
                      <Settings className="w-4 h-4 mr-1" />
                      配置
                    </Button>
                  </div>
                </div>
              </CardHeader>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
