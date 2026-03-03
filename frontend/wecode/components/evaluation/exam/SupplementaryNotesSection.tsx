// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { useTheme } from '@/features/theme/ThemeProvider'
import EnhancedMarkdown from '@/components/common/EnhancedMarkdown'

interface SupplementaryNotesSectionProps {
  notes: string
  disabled: boolean
  onNotesChange: (notes: string) => void
  required?: boolean
}

export function SupplementaryNotesSection({
  notes,
  disabled,
  onNotesChange,
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
        <div className="w-1.5 h-7 bg-sky-500 rounded-full" />
        <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
          作答说明
          {required && <span className="text-[#DF2029] text-sm font-normal">（必传）</span>}
        </h2>
      </div>
      <div className="bg-white rounded-3xl shadow-sm border border-gray-100 p-7 sm:p-9">
        <div className="bg-sky-50 border border-sky-100 rounded-2xl p-5 mb-5">
          <p className="text-[1rem] text-sky-800 leading-[1.8]">
            请先阐述你本次借助 AI 完成作答的整体思路，以及计划使用的模型与工具，例如：
          </p>
          <p className="text-[1rem] text-sky-700 leading-[1.8] mt-2">
            计划使用哪些模型或平台、如何在不同阶段选用合适的模型或工具、各自用于哪些环节，有哪些参考来源或辅助工具。
          </p>
          <p className="text-[1rem] text-sky-700 leading-[1.8] mt-2">
            也可以说明其他你认为可以体现自己AI使用思路、技巧的信息。完成思路阐述后，请在下方上传交互过程记录及最终产出结果。
          </p>
        </div>

        {/* Edit/Preview Toggle */}
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm text-gray-500">
            {showPreview ? '预览模式' : '编辑模式'}（支持 Markdown 格式）
          </span>
          {!disabled && (
            <button
              onClick={() => setShowPreview(!showPreview)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-sky-600 bg-sky-50 hover:bg-sky-100 rounded-lg transition"
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
            placeholder="请在此输入你的作答说明...（支持 Markdown 格式）"
            disabled={disabled}
            className="w-full min-h-[200px] px-5 py-4 rounded-2xl border border-gray-200 text-[1rem] leading-[1.8] resize-y focus:border-sky-400 focus:ring-2 focus:ring-sky-100 transition placeholder:text-gray-300 disabled:opacity-50 disabled:bg-gray-50 font-mono text-sm"
          />
        )}

        {/* Character Count */}
        <div className="flex justify-between items-center mt-3">
          <span className="text-sm text-gray-400">{notes.length} 字</span>
          {!disabled && !showPreview && (
            <span className="text-xs text-gray-400">
              支持 **粗体**、*斜体*、`代码`、列表等 Markdown 语法
            </span>
          )}
        </div>
      </div>
    </section>
  )
}
