// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { Fragment } from 'react'
import { Dialog, Transition } from '@headlessui/react'
import { XMarkIcon } from '@heroicons/react/24/outline'
import { useTranslation } from '@/hooks/useTranslation'

interface MobileSidebarProps {
  isOpen: boolean
  onClose: () => void
  children: React.ReactNode
  title?: string
  hideTitle?: boolean // New prop to hide title bar while keeping structure
}

export function MobileSidebar({
  isOpen,
  onClose,
  children,
  title,
  hideTitle = false,
}: MobileSidebarProps) {
  const { t } = useTranslation()

  return (
    <Transition.Root show={isOpen} as={Fragment}>
      <Dialog as="div" className="relative z-50 lg:hidden" onClose={onClose}>
        {/* 背景遮罩层 - 增强视觉效果 */}
        <Transition.Child
          as={Fragment}
          enter="transition-opacity ease-out duration-300"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="transition-opacity ease-in duration-200"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" />
        </Transition.Child>

        <div className="fixed inset-0 flex">
          <Transition.Child
            as={Fragment}
            enter="transition ease-out duration-300 transform"
            enterFrom="-translate-x-full"
            enterTo="translate-x-0"
            leave="transition ease-in duration-200 transform"
            leaveFrom="translate-x-0"
            leaveTo="-translate-x-full"
          >
            <Dialog.Panel className="relative mr-16 flex w-full max-w-xs flex-1">
              {/* 关闭按钮 - 改进样式 */}
              <Transition.Child
                as={Fragment}
                enter="ease-out duration-300 delay-100"
                enterFrom="opacity-0 scale-75"
                enterTo="opacity-100 scale-100"
                leave="ease-in duration-200"
                leaveFrom="opacity-100 scale-100"
                leaveTo="opacity-0 scale-75"
              >
                <div className="absolute left-full top-0 flex w-16 justify-center pt-5">
                  <button
                    type="button"
                    className="touch-target -m-2.5 p-2.5 rounded-full bg-black/20 hover:bg-black/30 active:bg-black/40 backdrop-blur-sm transition-all duration-200"
                    onClick={onClose}
                    aria-label={t('common:common.close_sidebar')}
                  >
                    <XMarkIcon className="h-6 w-6 text-white drop-shadow-lg" aria-hidden="true" />
                  </button>
                </div>
              </Transition.Child>

              {/* 侧边栏内容容器 - 现代化设计 */}
              <div className="flex grow flex-col overflow-y-auto bg-surface shadow-2xl w-full">
                {/* Only render title bar if hideTitle is false */}
                {!hideTitle && title && (
                  <div className="flex h-12 shrink-0 items-center px-4 border-b border-border/50 bg-gradient-to-r from-surface to-muted/30">
                    <h2 className="text-base font-semibold text-text-primary tracking-tight">
                      {title}
                    </h2>
                  </div>
                )}
                <div className="flex-1 flex flex-col min-h-0">{children}</div>
              </div>
            </Dialog.Panel>
          </Transition.Child>
        </div>
      </Dialog>
    </Transition.Root>
  )
}

export default MobileSidebar
