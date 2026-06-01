// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useTranslation } from '@/hooks/useTranslation'
import { MyResources } from './components/MyResources'

export function ResourceLibraryPage() {
  const { t } = useTranslation('resource-library')

  return (
    <main className="h-full overflow-y-auto bg-base text-text-primary">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 pb-6 pt-3 sm:px-6 lg:px-8">
        <section className="flex flex-col gap-4">
          <div data-testid="resource-library-content">
            <MyResources title={t('title')} />
          </div>
        </section>
      </div>
    </main>
  )
}

export default ResourceLibraryPage
