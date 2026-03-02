// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { FileText, Download, X } from 'lucide-react'
import { downloadEvaluationFile } from '@wecode/api/evaluation-shared'
import type { ExamAttachment } from '@wecode/types/evaluation-exam'

interface SupplementaryNotesSectionProps {
  notes: string
  files: ExamAttachment[]
  disabled: boolean
  onNotesChange: (notes: string) => void
  onFileRemove: (index: number) => void
  required?: boolean
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}

export function SupplementaryNotesSection({
  notes,
  files,
  disabled,
  onNotesChange,
  onFileRemove,
  required,
}: SupplementaryNotesSectionProps) {
  return (
    <section className="animate-[slideDown_0.35s_ease-out]">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-1.5 h-7 bg-sky-500 rounded-full" />
        <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
          作答补充说明
          {required && <span className="text-[#DF2029] text-sm font-normal">（必传）</span>}
        </h2>
      </div>
      <div className="bg-white rounded-3xl shadow-sm border border-gray-100 p-7 sm:p-9">
        <div className="bg-sky-50 border border-sky-100 rounded-2xl p-5 mb-5">
          <p className="text-[1rem] text-sky-800 leading-[1.8]">
            请补充说明你本次借助 AI 完成作答的整体思路，以及使用的模型与工具，例如：
          </p>
          <p className="text-[1rem] text-sky-700 leading-[1.8] mt-2">
            使用过哪些模型或平台、是否在不同阶段切换过不同模型或工具、各自用于哪些环节，是否有其他引用来源或辅助工具。
          </p>
          <p className="text-[1rem] text-sky-700 leading-[1.8] mt-2">
            也可以补充其他你认为可以体现自己AI使用思路、技巧的信息。
          </p>
        </div>
        <textarea
          value={notes}
          onChange={e => onNotesChange(e.target.value)}
          placeholder="请在此输入你的作答补充说明..."
          disabled={disabled}
          className="w-full min-h-[200px] px-5 py-4 rounded-2xl border border-gray-200 text-[1rem] leading-[1.8] resize-y focus:border-red-400 focus:ring-2 focus:ring-red-100 transition placeholder:text-gray-300 disabled:opacity-50 disabled:bg-gray-50"
        />
        <div className="flex justify-end mt-2">
          <span className="text-sm text-gray-400">{notes.length} 字</span>
        </div>

        {/* Supplementary Notes File Display */}
        {files.length > 0 && (
          <div className="mt-4 space-y-2">
            <p className="text-sm text-gray-500">已上传的补充说明文件：</p>
            {files.map((file, index) => (
              <div
                key={file.key}
                className="flex items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 p-3"
              >
                <FileText className="h-5 w-5 text-gray-400 flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-gray-700">{file.filename}</p>
                  {file.size && (
                    <p className="text-xs text-gray-400">{formatFileSize(file.size)}</p>
                  )}
                </div>
                <div className="flex gap-1">
                  <button
                    onClick={() => downloadEvaluationFile(file.key, file.filename)}
                    className="h-8 w-8 flex items-center justify-center rounded-lg hover:bg-gray-200 transition"
                    title="下载"
                  >
                    <Download className="h-4 w-4 text-gray-500" />
                  </button>
                  {!disabled && (
                    <button
                      onClick={() => onFileRemove(index)}
                      className="h-8 w-8 flex items-center justify-center rounded-lg hover:bg-red-50 transition text-destructive hover:text-destructive"
                      title="删除"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
