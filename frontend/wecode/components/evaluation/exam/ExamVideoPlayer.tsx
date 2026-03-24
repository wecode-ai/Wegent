// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useRef } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ExamVideoPlayerProps {
  /** S3 storage key for the video */
  videoKey: string
  /** Video filename for display */
  filename?: string
  /** Additional CSS classes */
  className?: string
}

/**
 * Video player component for exam introduction videos.
 * Uses native browser controls for play/pause, progress bar, volume, and fullscreen.
 */
export function ExamVideoPlayer({ videoKey, className }: ExamVideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Build the video URL using the backend proxy stream endpoint (inline viewing)
  const videoUrl = `/api/wecode/evaluation/shared/files/stream?s3_path=${encodeURIComponent(videoKey)}`

  const handleLoadedData = () => {
    setIsLoading(false)
  }

  const handleError = () => {
    setIsLoading(false)
    setError('Failed to load video')
  }

  if (error) {
    return (
      <div
        className={cn(
          'rounded-xl bg-gray-100 border border-gray-200 flex items-center justify-center p-8',
          className
        )}
      >
        <div className="text-center">
          <p className="text-gray-500 text-sm">{error}</p>
        </div>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'relative rounded-xl overflow-hidden bg-black border border-gray-200',
        className
      )}
    >
      {/* Loading State */}
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-900 z-10">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="h-8 w-8 animate-spin text-white" />
            <p className="text-white text-sm">Loading video...</p>
          </div>
        </div>
      )}

      {/* Video Element - using native controls for progress bar and seeking */}
      <video
        ref={videoRef}
        src={videoUrl}
        className="w-full aspect-video"
        onLoadedData={handleLoadedData}
        onError={handleError}
        controls
        playsInline
      />
    </div>
  )
}
