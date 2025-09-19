// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Menu } from '@headlessui/react'

import { useUser } from '@/features/common/UserContext'

type UserMenuProps = {
  position?: string
}

export default function UserMenu({ position = 'right-6' }: UserMenuProps) {
  const { user, logout } = useUser()
  const userDisplayName = user?.user_name || 'User'

  return (
    <div className={`absolute ${position}`}>
      <Menu as="div" className="relative">
        <Menu.Button className="px-3 py-1 bg-[#21262d] border border-[#30363d] rounded-full flex items-center justify-center text-sm font-medium hover:bg-[#30363d] transition-colors duration-200">
          {userDisplayName}
        </Menu.Button>
        <Menu.Items className="absolute top-full mt-2 right-0 bg-[#161b22] border border-[#30363d] rounded-lg shadow-xl z-30 min-w-[120px] py-1 focus:outline-none">
          <Menu.Item>
            {({ active }) => (
              <button
                onClick={logout}
                className={`w-full px-3 py-2 text-xs text-left text-white transition-colors duration-150 ${
                  active ? 'bg-[#21262d]' : ''
                }`}
              >
                Logout
              </button>
            )}
          </Menu.Item>
        </Menu.Items>
      </Menu>
    </div>
  )
}