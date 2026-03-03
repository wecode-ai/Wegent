// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Icon } from './ExamIcons'

interface CheckItem {
  label: string
  done: boolean
  required: boolean
}

interface SubmitSectionProps {
  checkItems: CheckItem[]
  submitCount: number
  totalFileCount: number
  isSubmitReady: boolean
  submitButtonText: string
  onSubmit: () => void
}

export function SubmitSection({
  checkItems,
  submitCount,
  totalFileCount,
  isSubmitReady,
  submitButtonText,
  onSubmit,
}: SubmitSectionProps) {
  return (
    <section className="animate-[slideDown_0.35s_ease-out]">
      <div className="bg-white rounded-3xl shadow-sm border border-gray-100 p-7 sm:p-9">
        <h3 className="text-[1rem] font-bold text-gray-700 mb-5">
          提交检查
          {submitCount > 0 && (
            <span className="ml-2 text-sm font-normal text-gray-400">
              （第 {submitCount + 1} 次提交）
            </span>
          )}
        </h3>
        <div className="grid grid-cols-3 gap-3 mb-7">
          {checkItems.map((item, i) => (
            <div
              key={i}
              className={`flex items-center gap-2.5 px-4 py-3 rounded-xl text-sm font-medium ${item.done ? 'bg-green-50 text-green-700' : item.required ? 'bg-red-50 text-red-400' : 'bg-gray-50 text-gray-400'}`}
            >
              {item.done ? (
                <Icon name="checkCircle" size={18} className="text-green-500" />
              ) : (
                <div
                  className={`w-4.5 h-4.5 rounded-full border-2 ${item.required ? 'border-red-300' : 'border-gray-300'}`}
                />
              )}
              <span>
                {item.label}
                {item.required && !item.done ? ' *' : ''}
              </span>
            </div>
          ))}
        </div>
        <div className="flex flex-col sm:flex-row items-center gap-4 sm:justify-between">
          <div className="text-sm text-gray-400">
            <p>每道题目总附件数不能超过 20 个，当前已上传 {totalFileCount} 个</p>
          </div>
          <button
            onClick={onSubmit}
            disabled={!isSubmitReady}
            className={`w-full sm:w-auto px-10 py-3.5 rounded-2xl text-[1rem] font-bold transition-all ${
              isSubmitReady
                ? 'bg-[#DF2029] hover:bg-[#c81d25] text-white shadow-lg shadow-red-200/50 hover:shadow-red-300/60 active:scale-[0.98]'
                : 'bg-gray-100 text-gray-400 cursor-not-allowed'
            }`}
          >
            {submitButtonText}
          </button>
        </div>
      </div>
    </section>
  )
}
