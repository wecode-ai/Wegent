// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'

export type ResourceLibraryTab = 'discover' | 'mine'

interface ResourceLibraryTabsProps {
  value: ResourceLibraryTab
  onValueChange: (value: ResourceLibraryTab) => void
}

const RESOURCE_LIBRARY_TABS: ResourceLibraryTab[] = ['discover', 'mine']

export function ResourceLibraryTabs({ value, onValueChange }: ResourceLibraryTabsProps) {
  const { t } = useTranslation('resource-library')

  return (
    <div className="flex items-center gap-2" role="group" aria-label={t('title')}>
      {RESOURCE_LIBRARY_TABS.map(tab => {
        const isActive = value === tab

        return (
          <Button
            key={tab}
            type="button"
            variant={isActive ? 'primary' : 'outline'}
            size="sm"
            aria-pressed={isActive}
            data-testid={`resource-library-${tab}-tab`}
            onClick={() => onValueChange(tab)}
          >
            {t(`tabs.${tab}`)}
          </Button>
        )
      })}
    </div>
  )
}
