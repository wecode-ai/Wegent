// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useState, useEffect } from 'react';
import { Card, Button } from 'antd';
import { XMarkIcon } from '@heroicons/react/24/outline';

interface DiscountNotificationProps {
  className?: string;
}

interface DiscountInfo {
  title: string;
  discountPercentage: number;
}

export default function DiscountNotification({ className = '' }: DiscountNotificationProps) {
  const [isVisible, setIsVisible] = useState(true);
  const [discountInfo, setDiscountInfo] = useState<DiscountInfo | null>(null);

  useEffect(() => {
    const isClosed = localStorage.getItem('discountNotificationClosed');
    if (isClosed === 'true') {
      setIsVisible(false);
    }

    const mockDiscount: DiscountInfo = {
      title: '🎉 试用期间，在Wegent中使用Claude模型配额消耗降低',
      discountPercentage: 90,
    };

    setDiscountInfo(mockDiscount);
  }, []);

  const handleClose = () => {
    setIsVisible(false);
    // 保存到本地存储，记住用户已关闭通知
    localStorage.setItem('discountNotificationClosed', 'true');
  };

  const handleReopen = () => {
    setIsVisible(true);
    // 清除本地存储中的关闭状态
    localStorage.removeItem('discountNotificationClosed');
  };

  if (!discountInfo) {
    return null;
  }

  // 如果通知被关闭,显示一个小的重新开启按钮
  if (!isVisible) {
    return (
      <div className={`w-full ${className}`}>
        <div className="flex justify-end">
          <Button
            type="text"
            size="small"
            className="text-gray-400 hover:text-orange-600 text-xs"
            onClick={handleReopen}
          >
            显示折扣通知
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={`w-full ${className}`}>
      <Card
        className={`
          relative overflow-hidden
          bg-gradient-to-r from-orange-50 to-red-50
          border border-orange-200
          shadow-sm
          transition-all duration-300
          hover:shadow-md
        `}
        bodyStyle={{ padding: '12px' }}
      >
        {/* 关闭按钮 */}
        <Button
          type="text"
          size="small"
          className="absolute top-2 right-2 text-gray-400 hover:text-gray-600 z-50"
          style={{
            position: 'absolute',
            top: '8px !important',
            right: '8px !important',
            left: 'auto !important',
          }}
          icon={<XMarkIcon className="w-4 h-4" />}
          onClick={handleClose}
        />

        <div className="flex items-center gap-3">
          {/* 内容区域 */}
          <div className="flex-1 min-w-0">
            {/* 标题和折扣 */}
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <h3 className="text-base font-semibold leading-tight text-gray-900 dark:text-gray-100">
                {discountInfo.title}
              </h3>
              <span className="inline-flex items-center whitespace-nowrap px-2 py-0.5 rounded-full text-xs font-medium leading-none bg-red-100 text-red-800">
                {discountInfo.discountPercentage}%
              </span>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
