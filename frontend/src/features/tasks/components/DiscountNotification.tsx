// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import NotificationBanner from './NotificationBanner'

interface DiscountNotificationProps {
  className?: string
}

export default function DiscountNotification({ className = '' }: DiscountNotificationProps) {
  return (
    <NotificationBanner
      className={className}
      storageKey="discountNotificationClosed"
      title="🎉 试用期间，在Wegent中使用Claude模型配额消耗降低"
      badgeText="20%"
      reopenLabel="显示折扣通知"
      variant="warning"
    />
  )
}
