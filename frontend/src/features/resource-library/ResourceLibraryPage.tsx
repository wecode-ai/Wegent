// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'

import { DiscoverResources } from './components/DiscoverResources'
import { MyResources } from './components/MyResources'
import { ResourceLibraryTabs, type ResourceLibraryTab } from './components/ResourceLibraryTabs'
import { ResourceTypeFilter } from './components/ResourceTypeFilter'
import { useTranslation } from '@/hooks/useTranslation'
import type { ResourceLibraryTypeFilter } from './types'

export function ResourceLibraryPage() {
  const { t } = useTranslation('resource-library')
  const [activeTab, setActiveTab] = useState<ResourceLibraryTab>('discover')
  const [activeFilter, setActiveFilter] = useState<ResourceLibraryTypeFilter>('all')

  return (
    <main className="h-full overflow-y-auto bg-base text-text-primary">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="text-xl font-semibold">{t('title')}</h1>
          </div>
          <ResourceLibraryTabs value={activeTab} onValueChange={setActiveTab} />
        </header>

        <section className="flex flex-col gap-4">
          <ResourceTypeFilter value={activeFilter} onValueChange={setActiveFilter} />

          <div data-testid="resource-library-content">
            {activeTab === 'discover' ? (
              <DiscoverResources resourceType={activeFilter} />
            ) : (
              <MyResources resourceType={activeFilter} />
            )}
          </div>
        </section>
      </div>
    </main>
  )
}

export default ResourceLibraryPage
