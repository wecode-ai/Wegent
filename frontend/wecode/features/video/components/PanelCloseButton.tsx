// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { X } from 'lucide-react'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'

interface PanelCloseButtonProps {
  onClose: () => void
  label?: string
  testId?: string
}

export function PanelCloseButton({
  onClose,
  label = 'Close panel',
  testId,
}: PanelCloseButtonProps) {
  const isMobile = useIsMobile()

  return (
    <button
      type="button"
      aria-label={label}
      data-testid={testId}
      onClick={onClose}
      className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[#939393] transition-colors hover:bg-[#f5f5f5] hover:text-[#333333] active:bg-[#eeeeee] ${isMobile ? '!-mr-3.5' : ''}`}
    >
      <X className="h-4 w-4 pointer-events-none" />
    </button>
  )
}
