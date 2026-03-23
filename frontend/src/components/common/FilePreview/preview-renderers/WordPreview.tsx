// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'

interface WordPreviewProps {
  content: string
  filename?: string
}

export function WordPreview({ content }: WordPreviewProps) {
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
