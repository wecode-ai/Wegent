// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import type React from 'react'
import { CheckCircle } from 'lucide-react'

interface CompletedStateProps {
  examDurationSeconds: number | null
  hint?: React.ReactNode
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60

  if (hours > 0) {
    return `${hours}小时${minutes}分钟`
  } else if (minutes > 0) {
    return `${minutes}分钟${secs}秒`
  } else {
    return `${secs}秒`
  }
}

export function CompletedState({ examDurationSeconds, hint }: CompletedStateProps) {
  return (
    <section className="animate-[slideDown_0.35s_ease-out]">
      <div className="bg-gray-50 rounded-3xl border border-gray-200 p-7 sm:p-9 text-center">
        <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-green-100 flex items-center justify-center">
          <CheckCircle className="w-8 h-8 text-green-500" />
        </div>
        {hint && <div className="mb-4">{hint}</div>}
        <h3 className="text-lg font-bold text-gray-700 mb-2">实操题考试已结束</h3>
        {examDurationSeconds !== null && examDurationSeconds > 0 && (
          <p className="text-sm text-gray-500">
            您的实操题考试已结束，整体用时 {formatDuration(examDurationSeconds)}
          </p>
        )}
      </div>
    </section>
  )
}
