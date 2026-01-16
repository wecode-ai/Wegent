// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Menu } from '@headlessui/react'
import { ChevronDownIcon } from '@heroicons/react/24/outline'
import { useTranslation } from '@/hooks/useTranslation'
import { OpenLinks } from '@/types/api'

interface OpenMenuProps {
  openLinks?: OpenLinks | null
}

export default function OpenMenu({ openLinks }: OpenMenuProps) {
  const { t } = useTranslation()

  const handleVSCodeOpen = () => {
    if (openLinks?.vscode_link) {
      window.location.href = openLinks.vscode_link
    }
  }

  const handleGitOpen = () => {
    if (openLinks?.git_link) {
      window.open(openLinks.git_link, '_blank', 'noopener,noreferrer')
    }
  }

  // Don't render if no open links
  if (!openLinks) {
    return null
  }

  const isVSCodeDisabled = !openLinks.vscode_link
  const isGitDisabled = !openLinks.git_link

  return (
    <Menu as="div" className="relative hidden sm:block">
      <Menu.Button className="inline-flex items-center gap-1 h-8 pl-2 pr-3 text-sm font-medium text-text-primary bg-base hover:bg-hover border border-border rounded-[7px] transition-colors">
        <span>{t('common:tasks.open_from')}</span>
        <ChevronDownIcon className="h-3.5 w-3.5" />
      </Menu.Button>
      <Menu.Items
        className="absolute right-0 top-full mt-1 bg-surface border border-border rounded-lg z-30 w-max py-1"
        style={{ boxShadow: 'var(--shadow-popover)' }}
      >
        <Menu.Item disabled={isVSCodeDisabled}>
          {({ active }) => (
            <button
              onClick={handleVSCodeOpen}
              disabled={isVSCodeDisabled}
              className={`w-full px-3 py-2 text-sm text-left flex items-center ${
                isVSCodeDisabled
                  ? 'text-text-muted cursor-not-allowed opacity-50'
                  : active
                    ? 'bg-muted text-text-primary'
                    : 'text-text-primary'
              }`}
            >
              <svg
                className="h-3.5 w-3.5 mr-2"
                fill="currentColor"
                viewBox="0 0 24 24"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path d="M23.15 2.587L18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z" />
              </svg>
              {t('common:tasks.open_from_vscode')}
            </button>
          )}
        </Menu.Item>
        <Menu.Item disabled={isGitDisabled}>
          {({ active }) => (
            <button
              onClick={handleGitOpen}
              disabled={isGitDisabled}
              className={`w-full px-3 py-2 text-sm text-left flex items-center ${
                isGitDisabled
                  ? 'text-text-muted cursor-not-allowed opacity-50'
                  : active
                    ? 'bg-muted text-text-primary'
                    : 'text-text-primary'
              }`}
            >
              <svg
                className="h-3.5 w-3.5 mr-2"
                fill="currentColor"
                viewBox="0 0 24 24"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
              </svg>
              {t('common:tasks.open_from_git')}
            </button>
          )}
        </Menu.Item>
      </Menu.Items>
    </Menu>
  )
}
