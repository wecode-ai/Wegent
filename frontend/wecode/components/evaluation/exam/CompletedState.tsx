// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { InfoIcon } from 'lucide-react'

interface CompletedStateProps {
  submitCount: number
}

export function CompletedState({ submitCount }: CompletedStateProps) {
  return (
    <section className="animate-[slideDown_0.35s_ease-out]">
      <div className="bg-gray-50 rounded-3xl border border-gray-200 p-7 sm:p-9 text-center">
        <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-gray-200 flex items-center justify-center">
          <InfoIcon className="w-8 h-8 text-gray-400" />
        </div>
        <h3 className="text-lg font-bold text-gray-700 mb-2">考试已结束</h3>
        <p className="text-sm text-gray-500">您的考试已结束，共提交了 {submitCount} 次答案</p>
      </div>
    </section>
  )
}
