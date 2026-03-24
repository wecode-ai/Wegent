// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { FileIcon } from 'lucide-react'
import { formatFileSize } from '../utils'

interface UnknownPreviewProps {
  filename: string
  fileSize?: number
}

export function UnknownPreview({ filename, fileSize }: UnknownPreviewProps) {
  return (
    <div className="flex flex-col h-full bg-surface items-center justify-center p-8">
      <FileIcon className="w-24 h-24 text-primary/50 mb-6" />
      <h3 className="text-lg font-medium mb-2 text-center break-all">{filename}</h3>
      {fileSize && <p className="text-sm text-text-secondary mb-6">{formatFileSize(fileSize)}</p>}
      <p className="text-text-secondary text-sm">该文件类型暂不支持预览，请下载查看</p>
    </div>
  )
}
