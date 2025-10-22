// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Menu } from '@headlessui/react'
import { Button } from 'antd'

import { useUser } from '@/features/common/UserContext'
import { useTranslation } from '@/hooks/useTranslation'

type UserMenuProps = {
  className?: string
}

export default function UserMenu({ className = '' }: UserMenuProps) {
  const { t } = useTranslation('common')
  const { user, logout } = useUser()
  const userDisplayName = user?.user_name || t('user.default_name')

  return (
    <div className={className}>
      <Menu as="div" className="relative">
        <Menu.Button className="px-3 py-1 bg-muted border border-border rounded-full flex items-center justify-center text-sm font-medium text-text-primary hover:bg-border/40 transition-colors duration-200">
          {userDisplayName}
        </Menu.Button>
        <Menu.Items
          className="absolute top-full right-0 mt-2 min-w-[120px] rounded-lg border border-border bg-surface py-1 z-30 focus:outline-none"
          style={{ boxShadow: 'var(--shadow-popover)' }}
        >
          <Menu.Item>
            {({ active }) => (
              <Button
                type="text"
                onClick={logout}
                className={`!w-full !text-left !px-2 !py-1.5 !text-xs !text-text-primary ${
                  active ? '!bg-muted' : '!bg-transparent'
                }`}
              >
                {t('user.logout')}
              </Button>
            )}
          </Menu.Item>
        </Menu.Items>
      </Menu>
    </div>
  )
}
