// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useIsMobile } from './hooks/useMediaQuery'

interface WorkbenchToggleProps {
  isOpen: boolean
  onOpen: () => void
  onClose: () => void
  className?: string
}

export default function WorkbenchToggle({
  isOpen,
  onOpen,
  onClose,
  className = '',
}: WorkbenchToggleProps) {
  const isMobile = useIsMobile()

  // 在移动端不显示按钮
  if (isMobile) {
    return null
  }

  return (
    <button
      onClick={isOpen ? onClose : onOpen}
      className={`relative w-8 h-8 rounded-[7px] bg-base border border-border hover:bg-hover focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-primary transition-all duration-200 ${className}`}
      title={isOpen ? '关闭工作台' : '打开工作台'}
    >
      <svg
        className="w-3.5 h-3.5 text-text-primary absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 transition-transform duration-200"
        style={{
          transform: isOpen ? 'translate(-50%, -50%) rotate(180deg)' : 'translate(-50%, -50%)',
        }}
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M11 19l-7-7 7-7m8 14l-7-7 7-7"
        />
      </svg>
    </button>
  )
}
