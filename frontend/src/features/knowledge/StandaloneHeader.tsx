// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import Image from 'next/image'
import UserMenu from '@/features/layout/UserMenu'
import { GithubStarButton } from '@/features/layout/GithubStarButton'

/**
 * Standalone page header component - shows only Logo and user info
 */
export default function StandaloneHeader() {
  return (
    <header className="bg-surface border-b border-border">
      <div className="flex items-center justify-between px-6 py-3">
        {/* Left side Logo */}
        <div className="flex items-center gap-2">
          <Image
            src="/weibo-logo.png"
            alt="Weibo Logo"
            width={24}
            height={24}
            className="object-contain"
            priority
          />
          <span className="text-lg font-semibold text-text-primary">Wegent</span>
        </div>

        {/* Right side user info */}
        <div className="flex items-center gap-3">
          <GithubStarButton />
          <UserMenu />
        </div>
      </div>
    </header>
  )
}
