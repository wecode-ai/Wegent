// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useEffect } from 'react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { XMarkIcon } from '@heroicons/react/24/outline'

interface DiscountNotificationProps {
  className?: string
}

interface DiscountInfo {
  title: string
  discountPercentage: number
}

export default function DiscountNotification({ className = '' }: DiscountNotificationProps) {
  const [isVisible, setIsVisible] = useState(true)
  const [discountInfo, setDiscountInfo] = useState<DiscountInfo | null>(null)

  useEffect(() => {
    const isClosed = localStorage.getItem('discountNotificationClosed')
    if (isClosed === 'true') {
      setIsVisible(false)
    }

    const mockDiscount: DiscountInfo = {
      title: '🎉 试用期间，在Wegent中使用Claude模型配额消耗降低',
      discountPercentage: 20,
    }

    setDiscountInfo(mockDiscount)
  }, [])

  const handleClose = () => {
    setIsVisible(false)
    // 保存到本地存储，记住用户已关闭通知
    localStorage.setItem('discountNotificationClosed', 'true')
  }

  const handleReopen = () => {
    setIsVisible(true)
    // 清除本地存储中的关闭状态
    localStorage.removeItem('discountNotificationClosed')
  }

  if (!discountInfo) {
    return null
  }

  // 如果通知被关闭,显示一个小的重新开启按钮
  if (!isVisible) {
    return (
      <div className={`w-full ${className}`}>
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            className="text-gray-400 hover:text-orange-600 text-xs"
            onClick={handleReopen}
          >
            显示折扣通知
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className={`w-full ${className}`}>
      <Card
        className={`
          relative p-2.5 sm:p-3
          bg-gradient-to-r from-orange-50 to-red-50
          dark:from-orange-950/30 dark:to-red-950/30
          border border-orange-200 dark:border-orange-800
          shadow-sm
          transition-all duration-300
          hover:shadow-md
        `}
      >
        {/* 关闭按钮 */}
        <Button
          variant="ghost"
          size="icon"
          className="absolute top-1.5 right-1.5 sm:top-2 sm:right-2 h-5 w-5 sm:h-6 sm:w-6 text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 z-10"
          onClick={handleClose}
          aria-label="关闭通知"
        >
          <XMarkIcon className="w-3 h-3 sm:w-4 sm:h-4" />
        </Button>

        <div className="flex items-center gap-2 pr-6 sm:pr-8">
          {/* 内容区域 */}
          <div className="flex-1 min-w-0 flex items-center gap-2">
            {/* 标题 - 移动端单行截断 */}
            <span className="text-xs sm:text-sm font-medium leading-tight text-gray-900 dark:text-gray-100 truncate">
              {discountInfo.title}
            </span>
            {/* 徽章 */}
            <span className="inline-flex items-center whitespace-nowrap px-1.5 sm:px-2 py-0.5 rounded-full text-xs font-bold bg-red-500 text-white flex-shrink-0">
              {discountInfo.discountPercentage}%
            </span>
          </div>
        </div>
      </Card>
    </div>
  )
}
