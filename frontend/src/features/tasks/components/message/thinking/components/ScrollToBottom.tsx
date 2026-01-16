// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { memo } from 'react'
import { ChevronsDown } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { ScrollToBottomProps } from '../types'

/**
 * Floating button to scroll to bottom of content area
 */
const ScrollToBottom = memo(function ScrollToBottom({ show, onClick }: ScrollToBottomProps) {
  const { t } = useTranslation()

  if (!show) return null

  return (
    <button
      onClick={onClick}
      className="absolute bottom-2 right-2 flex items-center gap-1 text-xs text-blue-400 hover:text-blue-500 hover:font-semibold transition-colors"
      title={t('chat:thinking.scroll_to_bottom') || 'Scroll to bottom'}
    >
      <ChevronsDown className="h-3 w-3" />
      <span>{t('chat:thinking.scroll_to_bottom') || 'Scroll to bottom'}</span>
    </button>
  )
})

export default ScrollToBottom
