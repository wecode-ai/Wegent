// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useCallback, useEffect } from 'react'
import { ZoomIn, ZoomOut, RotateCw, Download, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface ImagePreviewProps {
  url: string
  filename: string
  onDownload?: () => void
  onClose?: () => void
  showToolbar?: boolean
}

export function ImagePreview({
  url,
  filename,
  onDownload,
  onClose,
  showToolbar = true,
}: ImagePreviewProps) {
  const [scale, setScale] = useState(1)
  const [rotation, setRotation] = useState(0)

  const handleZoomIn = useCallback(() => {
    setScale(s => Math.min(3, s + 0.1))
  }, [])

  const handleZoomOut = useCallback(() => {
    setScale(s => Math.max(0.1, s - 0.1))
  }, [])

  const handleRotate = useCallback(() => {
    setRotation(r => (r + 90) % 360)
  }, [])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case '+':
        case '=':
          handleZoomIn()
          break
        case '-':
          handleZoomOut()
          break
        case 'r':
        case 'R':
          handleRotate()
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleZoomIn, handleZoomOut, handleRotate])

  return (
    <div className="flex flex-col h-full">
      {showToolbar && (
        <div className="flex items-center justify-center gap-2 p-2 bg-surface dark:bg-gray-800 border-b border-border dark:border-gray-700">
          <Button variant="ghost" size="sm" onClick={handleZoomOut} title="缩小 (-)">
            <ZoomOut className="w-4 h-4" />
          </Button>
          <span className="text-sm text-text-secondary min-w-[60px] text-center">
            {Math.round(scale * 100)}%
          </span>
          <Button variant="ghost" size="sm" onClick={handleZoomIn} title="放大 (+)">
            <ZoomIn className="w-4 h-4" />
          </Button>
          <div className="w-px h-6 bg-border dark:bg-gray-600 mx-2" />
          <Button variant="ghost" size="sm" onClick={handleRotate} title="旋转 (R)">
            <RotateCw className="w-4 h-4" />
          </Button>
          {onDownload && (
            <>
              <div className="w-px h-6 bg-border dark:bg-gray-600 mx-2" />
              <Button variant="ghost" size="sm" onClick={onDownload} title="下载">
                <Download className="w-4 h-4" />
              </Button>
            </>
          )}
          {onClose && (
            <>
              <div className="w-px h-6 bg-border dark:bg-gray-600 mx-2" />
              <Button variant="ghost" size="sm" onClick={onClose} title="关闭 (Esc)">
                <X className="w-4 h-4" />
              </Button>
            </>
          )}
        </div>
      )}

      <div className="flex-1 overflow-auto bg-gray-100 dark:bg-gray-900 flex items-center justify-center p-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={filename}
          className="max-w-full max-h-full object-contain transition-transform duration-200"
          style={{
            transform: `scale(${scale}) rotate(${rotation}deg)`,
          }}
        />
      </div>
    </div>
  )
}
