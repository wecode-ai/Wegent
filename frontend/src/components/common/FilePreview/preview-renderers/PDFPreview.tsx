// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'

interface PDFPreviewProps {
  url: string
  filename: string
}

export function PDFPreview({ url, filename }: PDFPreviewProps) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 bg-gray-100 dark:bg-gray-900">
        <iframe src={url} className="w-full h-full border-0" title={filename} />
      </div>
    </div>
  )
}
