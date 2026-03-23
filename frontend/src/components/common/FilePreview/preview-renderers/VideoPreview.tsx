// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'

interface VideoPreviewProps {
  url: string
}

export function VideoPreview({ url }: VideoPreviewProps) {
  return (
    <div className="flex flex-col h-full bg-black">
      <div className="flex-1 flex items-center justify-center">
        <video src={url} controls className="max-w-full max-h-full" controlsList="nodownload">
          您的浏览器不支持视频播放
        </video>
      </div>
    </div>
  )
}
