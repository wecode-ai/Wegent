// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'

interface VideoPreviewProps {
  url: string
  restricted?: boolean
  onError?: () => void
}

export function VideoPreview({ url, restricted = false, onError }: VideoPreviewProps) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-black">
      <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden">
        <video
          key={url}
          src={url}
          controls
          preload="metadata"
          className="block h-full w-full object-contain"
          controlsList={restricted ? 'nodownload noremoteplayback' : 'nodownload'}
          disablePictureInPicture={restricted}
          onContextMenu={restricted ? event => event.preventDefault() : undefined}
          onError={onError}
        >
          您的浏览器不支持视频播放
        </video>
      </div>
    </div>
  )
}
