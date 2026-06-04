// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useState } from 'react'

import { useTranslation } from '@/hooks/useTranslation'
import { DiscoverResources } from './components/DiscoverResources'
import { MyResources } from './components/MyResources'
import { ResourceLibraryTabs, type ResourceLibraryTab } from './components/ResourceLibraryTabs'
import { ResourceTypeFilter } from './components/ResourceTypeFilter'
import type { ResourceLibraryTypeFilter } from './types'

function getInitialTab(): ResourceLibraryTab {
  if (typeof window === 'undefined') {
    return 'discover'
  }

  return new URLSearchParams(window.location.search).get('tab') === 'mine' ? 'mine' : 'discover'
}

function updateTabQueryParam(tab: ResourceLibraryTab) {
  if (typeof window === 'undefined') {
    return
  }

  const url = new URL(window.location.href)
  url.searchParams.set('tab', tab)
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
}

export function ResourceLibraryPage() {
  const { t } = useTranslation('resource-library')
  const [activeTab, setActiveTab] = useState<ResourceLibraryTab>(getInitialTab)
  const [resourceType, setResourceType] = useState<ResourceLibraryTypeFilter>('all')

  const handleTabChange = useCallback((nextTab: ResourceLibraryTab) => {
    setActiveTab(nextTab)
    updateTabQueryParam(nextTab)
  }, [])

  return (
    <main className="h-full overflow-y-auto bg-base text-text-primary">
      <div className="flex w-full flex-col gap-4 px-4 pb-6 pt-3 sm:px-6 lg:px-8">
        <section className="flex flex-col gap-4">
          <ResourceLibraryTabs value={activeTab} onValueChange={handleTabChange} />

          <div data-testid="resource-library-content">
            {activeTab === 'discover' ? (
              <DiscoverResources
                resourceType={resourceType}
                toolbarStart={
                  <ResourceTypeFilter value={resourceType} onValueChange={setResourceType} />
                }
              />
            ) : (
              <MyResources title={t('title')} />
            )}
          </div>
        </section>
      </div>
    </main>
  )
}

export default ResourceLibraryPage
