// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { AppWindow, ClipboardCheck } from 'lucide-react'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useTranslation } from '@/hooks/useTranslation'
import MarketplaceManagement from './MarketplaceManagement'
import PluginPublicationReviewQueue from './PluginPublicationReviewQueue'

type WeworkMarketplaceView = 'plugin-publications' | 'smart-apps'

function parseView(value: string | null): WeworkMarketplaceView {
  return value === 'smart-apps' ? 'smart-apps' : 'plugin-publications'
}

export default function WeworkMarketplaceManagement() {
  const { t } = useTranslation('admin')
  const router = useRouter()
  const searchParams = useSearchParams()
  const requestedView = parseView(searchParams.get('view'))
  const [view, setView] = useState<WeworkMarketplaceView>(requestedView)

  useEffect(() => {
    setView(requestedView)
  }, [requestedView])

  const handleViewChange = (value: string) => {
    const nextView = parseView(value)
    setView(nextView)
    const params = new URLSearchParams(searchParams.toString())
    params.set('tab', 'wework-marketplace')
    params.set('view', nextView)
    router.replace(`?${params.toString()}`, { scroll: false })
  }

  return (
    <div className="space-y-5" data-testid="wework-marketplace-management">
      <div className="border-b border-border pb-4">
        <h2 className="text-xl font-semibold text-text-primary">
          {t('marketplace_management.wework.title')}
        </h2>
        <p className="mt-1 text-sm text-text-muted">
          {t('marketplace_management.wework.description')}
        </p>
      </div>

      <Tabs value={view} onValueChange={handleViewChange}>
        <div className="flex">
          <TabsList className="grid w-full grid-cols-2 border border-border bg-surface shadow-sm sm:w-auto sm:min-w-[20rem]">
            <TabsTrigger
              value="plugin-publications"
              className="data-[state=active]:bg-primary data-[state=active]:text-white"
              data-testid="wework-marketplace-tab-plugin-publications"
            >
              <ClipboardCheck className="mr-2 h-4 w-4" aria-hidden />
              {t('marketplace_management.wework.plugin_tab')}
            </TabsTrigger>
            <TabsTrigger
              value="smart-apps"
              className="data-[state=active]:bg-primary data-[state=active]:text-white"
              data-testid="wework-marketplace-tab-smart-apps"
            >
              <AppWindow className="mr-2 h-4 w-4" aria-hidden />
              {t('marketplace_management.wework.smart_app_tab')}
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="plugin-publications" className="mt-5">
          {view === 'plugin-publications' ? <PluginPublicationReviewQueue /> : null}
        </TabsContent>
        <TabsContent value="smart-apps" className="mt-5">
          {view === 'smart-apps' ? <MarketplaceManagement mode="smart-app" /> : null}
        </TabsContent>
      </Tabs>
    </div>
  )
}
