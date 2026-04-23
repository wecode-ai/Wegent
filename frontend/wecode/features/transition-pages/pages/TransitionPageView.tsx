'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import * as Icons from 'lucide-react'
import type { LucideProps } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { getToken } from '@/apis/user'
import EnhancedMarkdown from '@/components/common/EnhancedMarkdown'

interface RenderedBlock {
  title: string
  title_font_size?: string
  icon?: string
  markdown: string
  buttons: Array<{
    label: string
    url: string
    variant: string
    target: string
  }>
}

interface RenderedPage {
  page: {
    title: string
    title_font_size?: string
    slug: string
  }
  group: {
    key: string
    name: string
  } | null
  blocks: RenderedBlock[]
}

function getBlockIcon(iconName?: string) {
  if (!iconName) return <Icons.FileText className="w-6 h-6" />
  const IconComponent = (Icons as unknown as Record<string, React.ComponentType<LucideProps>>)[iconName]
  if (!IconComponent) return <Icons.FileText className="w-6 h-6" />
  return <IconComponent className="w-6 h-6" />
}

export default function TransitionPageView() {
  const params = useParams()
  const slug = params.slug as string
  const [isDark, setIsDark] = useState(false)

  const [page, setPage] = useState<RenderedPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    setIsDark(prefersDark)
    loadPage()
  }, [slug])

  const loadPage = async () => {
    try {
      const token = getToken()
      const response = await fetch(`/api/v1/transition-pages/by-slug/${slug}/render`, {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (!response.ok) {
        if (response.status === 404) {
          throw new Error('页面不存在')
        }
        throw new Error('加载失败')
      }

      const data = await response.json()
      setPage(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : '未知错误')
    } finally {
      setLoading(false)
    }
  }

  const toggleTheme = () => {
    setIsDark(prev => !prev)
  }

  if (loading) {
    return (
      <div className={`min-h-screen flex items-center justify-center ${isDark ? 'bg-slate-950' : 'bg-slate-50'}`}>
        <div className="flex items-center gap-3">
          <Icons.Loader2 className="w-5 h-5 animate-spin text-slate-400" />
          <span className="text-slate-500">加载中...</span>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className={`min-h-screen flex items-center justify-center ${isDark ? 'bg-slate-950' : 'bg-slate-50'} px-4`}>
        <div className={`max-w-md w-full rounded-2xl p-8 shadow-lg ${isDark ? 'bg-slate-900 border border-slate-800' : 'bg-white border border-slate-200'}`}>
          <div className="text-center">
            <Icons.AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
            <h1 className={`text-lg font-semibold mb-2 ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>无法加载页面</h1>
            <p className="text-slate-500 mb-6">{error}</p>
            <Button onClick={() => window.location.reload()} className="rounded-full px-6">
              重试
            </Button>
          </div>
        </div>
      </div>
    )
  }

  if (!page) {
    return (
      <div className={`min-h-screen flex items-center justify-center ${isDark ? 'bg-slate-950' : 'bg-slate-50'}`}>
        <p className="text-slate-500">页面不存在</p>
      </div>
    )
  }

  return (
    <div className={`min-h-screen transition-colors duration-500 ${isDark ? 'bg-slate-950' : 'bg-slate-50'}`}>
      {/* Theme Toggle */}
      <div className="fixed top-4 right-4 z-50">
        <button
          onClick={toggleTheme}
          className={`w-10 h-10 rounded-full flex items-center justify-center transition-all shadow-md ${
            isDark
              ? 'bg-slate-800 text-amber-400 hover:bg-slate-700 border border-slate-700'
              : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200'
          }`}
        >
          {isDark ? <Icons.Sun className="w-5 h-5" /> : <Icons.Moon className="w-5 h-5" />}
        </button>
      </div>

      <div className="max-w-3xl mx-auto px-4 py-12">
        {/* Header */}
        <div className="text-center mb-10">
          <h1
            className={`font-bold tracking-tight ${
              isDark ? 'text-white' : 'text-slate-900'
            } ${
              page.page.title_font_size === 'small'
                ? 'text-xl'
                : page.page.title_font_size === 'medium'
                  ? 'text-2xl'
                  : page.page.title_font_size === 'xlarge'
                    ? 'text-4xl'
                    : 'text-3xl'
            }`}
          >
            {page.page.title}
          </h1>
        </div>

        {/* Content Blocks */}
        <div className="space-y-5">
          {page.blocks.map((block, index) => (
            <div
              key={index}
              className={`rounded-2xl p-6 transition-all duration-300 ${
                isDark
                  ? 'bg-slate-900 border border-slate-800 hover:border-slate-700 hover:shadow-lg hover:shadow-slate-900/50'
                  : 'bg-white border border-slate-200 hover:border-slate-300 hover:shadow-lg hover:shadow-slate-200/50'
              }`}
            >
              {/* Block Header */}
              <div className="flex items-center gap-3 mb-5">
                <div
                  className={`w-10 h-10 rounded-xl flex items-center justify-center ${
                    isDark
                      ? 'bg-teal-500/10 text-teal-400'
                      : 'bg-teal-50 text-teal-600'
                  }`}
                >
                  {getBlockIcon(block.icon)}
                </div>
                <h2
                  className={`font-semibold ${
                    isDark ? 'text-slate-100' : 'text-slate-800'
                  } ${
                    block.title_font_size === 'small'
                      ? 'text-lg'
                      : block.title_font_size === 'medium'
                        ? 'text-xl'
                        : block.title_font_size === 'xlarge'
                          ? 'text-3xl'
                          : 'text-xl'
                  }`}
                >
                  {block.title}
                </h2>
              </div>

              {/* Block Content */}
              <div className={`leading-relaxed ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                <EnhancedMarkdown source={block.markdown} theme={isDark ? 'dark' : 'light'} />
              </div>

              {/* Block Buttons */}
              {block.buttons.length > 0 && (
                <div className="flex flex-wrap gap-3 mt-6">
                  {block.buttons.map((btn, btnIndex) => (
                    <button
                      key={btnIndex}
                      onClick={() => window.open(btn.url, btn.target || '_blank')}
                      className={`px-5 py-2.5 rounded-xl font-medium transition-all ${
                        btn.variant === 'primary'
                          ? isDark
                            ? 'bg-teal-500 text-white hover:bg-teal-400 shadow-lg shadow-teal-500/25'
                            : 'bg-teal-600 text-white hover:bg-teal-700 shadow-lg shadow-teal-600/25'
                          : isDark
                            ? 'bg-slate-800 text-slate-300 hover:bg-slate-700 border border-slate-700'
                            : 'bg-slate-100 text-slate-700 hover:bg-slate-200 border border-slate-200'
                      }`}
                    >
                      {btn.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Empty State */}
        {page.blocks.length === 0 && (
          <div
            className={`text-center py-16 rounded-2xl ${
              isDark
                ? 'bg-slate-900 border border-slate-800'
                : 'bg-white border border-slate-200'
            }`}
          >
            <p className="text-slate-500">暂无内容</p>
          </div>
        )}
      </div>
    </div>
  )
}
