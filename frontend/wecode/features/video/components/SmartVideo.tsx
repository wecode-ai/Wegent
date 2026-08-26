// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { forwardRef, useEffect, useRef } from 'react'

interface SmartVideoProps extends Omit<
  React.VideoHTMLAttributes<HTMLVideoElement>,
  'src' | 'poster'
> {
  videoUrl: string
  poster?: string | null
  shouldPlay?: boolean
  lazyLoadWithPoster?: boolean
  warmupWhenNoPoster?: boolean
  onPlaybackFailedChange?: (failed: boolean) => void
}

export const SmartVideo = forwardRef<HTMLVideoElement, SmartVideoProps>(function SmartVideo(
  {
    videoUrl,
    poster,
    shouldPlay,
    lazyLoadWithPoster: _lazyLoadWithPoster,
    warmupWhenNoPoster: _warmupWhenNoPoster,
    onPlaybackFailedChange,
    onError,
    ...props
  },
  forwardedRef
) {
  const localRef = useRef<HTMLVideoElement | null>(null)

  useEffect(() => {
    const video = localRef.current
    if (!video || shouldPlay === undefined) return
    if (shouldPlay) {
      void video.play().catch(() => onPlaybackFailedChange?.(true))
    } else {
      video.pause()
    }
  }, [onPlaybackFailedChange, shouldPlay])

  return (
    <video
      ref={node => {
        localRef.current = node
        if (typeof forwardedRef === 'function') forwardedRef(node)
        else if (forwardedRef) forwardedRef.current = node
      }}
      src={videoUrl}
      poster={poster || undefined}
      onError={event => {
        onPlaybackFailedChange?.(true)
        onError?.(event)
      }}
      {...props}
    />
  )
})
