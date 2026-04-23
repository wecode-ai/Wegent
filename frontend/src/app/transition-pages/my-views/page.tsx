'use client'

import React, { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Loader2, Clock, FileText, ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { getToken } from '@/apis/user'

interface PageViews {
  page_id: string
  page_title: string
  viewed_blocks: Record<string, string>
}

export default function MyViewsPage() {
  const searchParams = useSearchParams()
  const pageId = searchParams.get('page_id')

  const [views, setViews] = useState<PageViews | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (pageId) {
      loadViews()
    }
  }, [pageId])

  const loadViews = async () => {
    try {
      const token = getToken()
      const response = await fetch(`/api/v1/transition-pages/${pageId}/my-views`, {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (!response.ok) {
        throw new Error('加载失败')
      }

      const data = await response.json()
      setViews({
        page_id: pageId!,
        page_title: '',
        viewed_blocks: data.viewed_blocks || {},
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : '未知错误')
    } finally {
      setLoading(false)
    }
  }

  const formatTime = (isoString: string) => {
    const date = new Date(isoString)
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="flex items-center gap-2 text-slate-500">
          <Loader2 className="w-5 h-5 animate-spin" />
          加载中...
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
        <div className="text-center">
          <p className="text-red-500 mb-4">{error}</p>
          <Button onClick={() => window.history.back()}>返回</Button>
        </div>
      </div>
    )
  }

  const viewedBlocks = views?.viewed_blocks || {}
  const hasViews = Object.keys(viewedBlocks).length > 0

  return (
    <div className="min-h-screen bg-slate-50 py-12 px-4">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center gap-4 mb-8">
          <Button variant="outline" size="sm" onClick={() => window.history.back()}>
            <ArrowLeft className="w-4 h-4 mr-1" />
            返回
          </Button>
          <h1 className="text-2xl font-bold text-slate-900">我的访问记录</h1>
        </div>

        {hasViews ? (
          <div className="space-y-4">
            {Object.entries(viewedBlocks).map(([blockKey, timestamp]) => (
              <div
                key={blockKey}
                className="bg-white rounded-xl p-5 border border-slate-200 shadow-sm"
              >
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 rounded-lg bg-teal-50 flex items-center justify-center flex-shrink-0">
                    <FileText className="w-5 h-5 text-teal-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="font-medium text-slate-900 mb-1">{blockKey}</h3>
                    <div className="flex items-center gap-2 text-sm text-slate-500">
                      <Clock className="w-4 h-4" />
                      <span>首次访问：{formatTime(timestamp)}</span>
                    </div>
                  </div>
                  <div className="flex-shrink-0">
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                      已查看
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-16 bg-white rounded-xl border border-slate-200">
            <FileText className="w-12 h-12 text-slate-300 mx-auto mb-4" />
            <p className="text-slate-500">暂无访问记录</p>
            <p className="text-sm text-slate-400 mt-2">
              访问页面内容后将在此显示记录
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
