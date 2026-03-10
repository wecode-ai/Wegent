// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { useTheme } from '@/features/theme/ThemeProvider'
import EnhancedMarkdown from '@/components/common/EnhancedMarkdown'

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

interface SupplementaryNotesSectionProps {
  notes: string
  disabled: boolean
  onNotesChange: (notes: string) => void
  onBlur?: () => void
  onManualSave?: () => void
  saveStatus?: SaveStatus
  lastSavedAt?: Date | null
  required?: boolean
}

export function SupplementaryNotesSection({
  notes,
  disabled,
  onNotesChange,
  onBlur,
  onManualSave,
  saveStatus = 'idle',
  lastSavedAt,
  required,
}: SupplementaryNotesSectionProps) {
  const { theme } = useTheme()
  // When disabled (e.g., after exam ends), default to preview mode to show full content
  const [showPreview, setShowPreview] = useState(disabled)

  // Auto-switch to preview mode when disabled changes to true (e.g., exam ends)
  useEffect(() => {
    if (disabled) {
      setShowPreview(true)
    }
  }, [disabled])

  return (
    <section className="animate-[slideDown_0.35s_ease-out]">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-1.5 h-7 bg-[#DF2029] rounded-full" />
        <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
          作答说明
          {required && <span className="text-[#DF2029] text-sm font-normal">（必传）</span>}
        </h2>
      </div>
      <div className="bg-white rounded-3xl shadow-sm border border-gray-100 p-7 sm:p-9">
        <div className="bg-gray-50 rounded-xl p-5 mb-5">
          <p className="text-sm font-bold text-gray-500 mb-2">
            请先阐述你本次借助 AI 完成作答的整体思路：
          </p>
          <p className="text-sm text-gray-600 leading-relaxed mb-1.5 flex items-start gap-2">
            <span className="text-gray-300 mt-0.5">•</span>
            <span>计划使用哪些模型或平台、如何在不同阶段选用合适的模型或工具</span>
          </p>
          <p className="text-sm text-gray-600 leading-relaxed mb-1.5 flex items-start gap-2">
            <span className="text-gray-300 mt-0.5">•</span>
            <span>各自用于哪些环节，有哪些参考来源或辅助工具</span>
          </p>
          <p className="text-sm text-gray-600 leading-relaxed flex items-start gap-2">
            <span className="text-gray-300 mt-0.5">•</span>
            <span>也可以说明其他你认为可以体现自己AI使用思路、技巧的信息</span>
          </p>
        </div>

        {/* Edit/Preview Toggle */}
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm text-gray-500">
            {showPreview ? '预览模式' : '编辑模式'}（支持 Markdown 格式，支持自动和手动保存）
          </span>
          {!disabled && (
            <button
              onClick={() => setShowPreview(!showPreview)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#DF2029] bg-red-50 hover:bg-red-100 rounded-lg transition"
            >
              {showPreview ? (
                <>
                  <EyeOff className="w-4 h-4" />
                  编辑
                </>
              ) : (
                <>
                  <Eye className="w-4 h-4" />
                  预览
                </>
              )}
            </button>
          )}
        </div>

        {/* Content Area */}
        {showPreview ? (
          <div className="min-h-[200px] rounded-2xl border border-gray-200 bg-gray-50 p-5">
            {notes.trim() ? (
              <div className="markdown-content">
                <EnhancedMarkdown source={notes} theme={theme === 'dark' ? 'dark' : 'light'} />
              </div>
            ) : (
              <p className="text-gray-400 text-center py-8">暂无内容</p>
            )}
          </div>
        ) : (
          <textarea
            value={notes}
            onChange={e => onNotesChange(e.target.value)}
            onBlur={onBlur}
            placeholder="请在此输入你的作答说明...（支持 Markdown 格式）"
            disabled={disabled}
            className="w-full min-h-[200px] px-5 py-4 rounded-2xl border border-gray-200 text-[1rem] leading-[1.8] resize-y transition placeholder:text-gray-300 disabled:opacity-50 disabled:bg-gray-50 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#DF2029]"
          />
        )}

        {/* Character Count, Save Button, and Save Status */}
        <div className="flex justify-between items-center mt-3">
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-400">{notes.length} 字</span>
            {/* Manual Save Button */}
            {!disabled && !showPreview && onManualSave && (
              <button
                onClick={onManualSave}
                disabled={saveStatus === 'saving'}
                className="px-3 py-1.5 text-xs font-medium text-[#DF2029] bg-red-50 hover:bg-red-100 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition"
              >
                {saveStatus === 'saving' ? '保存中...' : '立即保存'}
              </button>
            )}
            {/* Save Status Indicator */}
            {!disabled && !showPreview && (
              <span className="flex items-center gap-1.5 text-xs">
                {saveStatus === 'saving' && (
                  <>
                    <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
                    <span className="text-yellow-600">保存中...</span>
                  </>
                )}
                {saveStatus === 'saved' && (
                  <>
                    <svg
                      className="w-3.5 h-3.5 text-green-500"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                    <span className="text-green-600">
                      已保存
                      {lastSavedAt
                        ? ` ${lastSavedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
                        : ''}
                    </span>
                  </>
                )}
                {saveStatus === 'error' && (
                  <>
                    <svg
                      className="w-3.5 h-3.5 text-red-500"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                      />
                    </svg>
                    <span className="text-red-600">保存失败</span>
                  </>
                )}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            {!disabled && !showPreview && (
              <span className="text-xs text-gray-400">
                支持 **粗体**、*斜体*、`代码`、列表等 Markdown 语法
              </span>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
