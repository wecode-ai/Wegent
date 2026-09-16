// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'

interface PDFPreviewProps {
  url: string
  filename: string
  /**
   * Hide the browser viewer's own download/print toolbar. Chromium honours the
   * fragment parameters; Firefox and Safari ignore them and keep their toolbar.
   */
  protectedMode?: boolean
}

export function PDFPreview({ url, filename, protectedMode = false }: PDFPreviewProps) {
  const src = protectedMode ? `${url}#toolbar=0&navpanes=0` : url
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 bg-gray-100 dark:bg-gray-900">
        <iframe src={src} className="w-full h-full border-0" title={filename} />
      </div>
    </div>
  )
}
