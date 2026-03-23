// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { Music } from 'lucide-react'

interface AudioPreviewProps {
  url: string
  filename: string
}

export function AudioPreview({ url, filename }: AudioPreviewProps) {
  return (
    <div className="flex flex-col h-full bg-surface items-center justify-center p-8">
      <Music className="w-24 h-24 text-primary/50 mb-6" />
      <h3 className="text-lg font-medium mb-4 text-center break-all">{filename}</h3>
      <audio src={url} controls className="w-full max-w-md" controlsList="nodownload">
        您的浏览器不支持音频播放
      </audio>
    </div>
  )
}
