// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * Preview Toolbar Component
 *
 * Toolbar for the preview panel with controls:
 * - Refresh button
 * - URL address bar
 * - Viewport size selector
 */

import { useState, useCallback, KeyboardEvent } from 'react'
import {
  ArrowPathIcon,
  ComputerDesktopIcon,
  DeviceTabletIcon,
  DevicePhoneMobileIcon,
} from '@heroicons/react/24/outline'
import { useTranslation } from '@/hooks/useTranslation'
import type { ViewportSize } from '@/types/preview'
import { VIEWPORT_SIZES } from '@/types/preview'

interface PreviewToolbarProps {
  /** Current URL path */
  currentPath: string
  /** Current viewport size */
  viewportSize: ViewportSize
  /** Whether preview is loading */
  isLoading?: boolean
  /** Callback when refresh is clicked */
  onRefresh: () => void
  /** Callback when viewport size changes */
  onViewportChange: (size: ViewportSize) => void
  /** Callback when path changes */
  onNavigate: (path: string) => void
}

/**
 * Viewport size button component
 */
function ViewportButton({
  size,
  isActive,
  onClick,
  icon: Icon,
  label,
}: {
  size: ViewportSize
  isActive: boolean
  onClick: () => void
  icon: React.ComponentType<{ className?: string }>
  label: string
}) {
  return (
    <button
      onClick={onClick}
      className={`
        p-1.5 rounded-md transition-colors
        ${isActive
          ? 'bg-primary/10 text-primary'
          : 'text-text-muted hover:text-text-primary hover:bg-muted'
        }
      `}
      title={label}
    >
      <Icon className="w-4 h-4" />
    </button>
  )
}

export default function PreviewToolbar({
  currentPath,
  viewportSize,
  isLoading = false,
  onRefresh,
  onViewportChange,
  onNavigate,
}: PreviewToolbarProps) {
  const { t } = useTranslation('tasks')
  const [inputPath, setInputPath] = useState(currentPath)

  // Update input when currentPath changes externally
  useState(() => {
    setInputPath(currentPath)
  })

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        onNavigate(inputPath)
      }
    },
    [inputPath, onNavigate]
  )

  const handleBlur = useCallback(() => {
    // Reset to current path if user didn't press Enter
    setInputPath(currentPath)
  }, [currentPath])

  return (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-surface">
      {/* Refresh button */}
      <button
        onClick={onRefresh}
        disabled={isLoading}
        className={`
          p-1.5 rounded-md text-text-muted
          hover:text-text-primary hover:bg-muted
          disabled:opacity-50 disabled:cursor-not-allowed
          transition-colors
        `}
        title={t('preview.refresh')}
      >
        <ArrowPathIcon
          className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`}
        />
      </button>

      {/* URL address bar */}
      <div className="flex-1 flex items-center">
        <div className="flex-1 relative">
          <input
            type="text"
            value={inputPath}
            onChange={(e) => setInputPath(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            className="
              w-full px-3 py-1.5 text-sm
              bg-muted border border-border rounded-md
              text-text-primary placeholder-text-muted
              focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary
            "
            placeholder="/"
          />
        </div>
      </div>

      {/* Viewport size selector */}
      <div className="flex items-center gap-1 border-l border-border pl-2 ml-2">
        <ViewportButton
          size="desktop"
          isActive={viewportSize === 'desktop'}
          onClick={() => onViewportChange('desktop')}
          icon={ComputerDesktopIcon}
          label={VIEWPORT_SIZES.desktop.label}
        />
        <ViewportButton
          size="tablet"
          isActive={viewportSize === 'tablet'}
          onClick={() => onViewportChange('tablet')}
          icon={DeviceTabletIcon}
          label={VIEWPORT_SIZES.tablet.label}
        />
        <ViewportButton
          size="mobile"
          isActive={viewportSize === 'mobile'}
          onClick={() => onViewportChange('mobile')}
          icon={DevicePhoneMobileIcon}
          label={VIEWPORT_SIZES.mobile.label}
        />
      </div>
    </div>
  )
}
