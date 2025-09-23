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
        <Menu.Button className="px-3 py-1 bg-theme-interactive border border-theme rounded-full flex items-center justify-center text-sm font-medium text-theme-primary transition-colors duration-200 hover:bg-theme-interactive">
          {userDisplayName}
        </Menu.Button>
        <Menu.Items className="absolute top-full mt-2 right-0 bg-theme-surface border border-theme rounded-lg shadow-xl z-30 min-w-[120px] py-1 focus:outline-none transition-colors">
          <Menu.Item>
            {({ active }) => (
              <Button
                type="text"
                onClick={logout}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '0px 4px',
                  fontSize: '0.8rem',
                  color: 'var(--color-text-primary)',
                  background: active ? 'var(--color-bg-interactive)' : 'transparent',
                  height: 'auto'
                }}
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
