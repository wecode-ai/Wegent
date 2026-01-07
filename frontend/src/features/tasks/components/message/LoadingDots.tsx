// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import React from 'react'

export default function LoadingDots() {
  return (
    <div className="flex items-center justify-center gap-1 h-4">
      <span
        className="w-1 h-1 bg-current rounded-full animate-bounce"
        style={{ animationDelay: '0ms' }}
      />
      <span
        className="w-1 h-1 bg-current rounded-full animate-bounce"
        style={{ animationDelay: '150ms' }}
      />
      <span
        className="w-1 h-1 bg-current rounded-full animate-bounce"
        style={{ animationDelay: '300ms' }}
      />
    </div>
  )
}
