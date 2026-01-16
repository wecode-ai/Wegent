// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Dialog } from '@headlessui/react'
import { ReactNode } from 'react'

type ModalProps = {
  isOpen: boolean
  onClose: () => void
  title: string
  children: ReactNode
  maxWidth?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl' | 'full'
}

export default function Modal({ isOpen, onClose, title, children, maxWidth = 'md' }: ModalProps) {
  // Map maxWidth to actual width class
  const maxWidthClass = {
    sm: 'max-w-sm',
    md: 'max-w-md',
    lg: 'max-w-lg',
    xl: 'max-w-xl',
    '2xl': 'max-w-2xl',
    '3xl': 'max-w-3xl',
    full: 'max-w-full',
  }[maxWidth]

  return (
    <Dialog open={isOpen} onClose={onClose} className="relative z-50">
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/50" aria-hidden="true" />

      {/* Full-screen container for centering */}
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <Dialog.Panel
          className={`bg-surface border border-border rounded-lg p-6 w-full ${maxWidthClass}`}
          style={{ boxShadow: 'var(--shadow-popover)' }}
        >
          {/* Header with title and close button */}
          <div className="mb-4">
            <Dialog.Title className="text-xl font-bold text-text-primary text-center">
              {title}
            </Dialog.Title>
          </div>

          {/* Content */}
          <div>{children}</div>
        </Dialog.Panel>
      </div>
    </Dialog>
  )
}
