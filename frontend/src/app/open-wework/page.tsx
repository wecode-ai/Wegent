// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { parseWeworkHandoff } from './handoff'

const WEWORK_DOWNLOAD_URL = 'https://github.com/wecode-ai/Wegent/releases/latest'

function WeworkHandoffContent() {
  const { t } = useTranslation('wework-open')
  const searchParams = useSearchParams()
  const destination = parseWeworkHandoff(new URLSearchParams(searchParams.toString()))

  return (
    <main className="flex min-h-screen items-center justify-center bg-base px-4 py-10">
      <section className="w-full max-w-md rounded-2xl border border-border bg-surface p-6 shadow-lg sm:p-8">
        <p className="text-sm font-semibold text-primary">{t('brand')}</p>
        <h1 className="mt-3 text-2xl font-semibold text-text-primary">
          {destination ? t('title') : t('invalid_title')}
        </h1>
        <p className="mt-3 text-sm leading-6 text-text-secondary">
          {destination ? t('description') : t('invalid_description')}
        </p>
        {destination && (
          <div className="mt-8 flex flex-col gap-3">
            <Button asChild variant="primary" size="lg" className="min-h-11 w-full">
              <a href={destination.weworkUrl} data-testid="open-wework-button">
                {t('open_wework')}
              </a>
            </Button>
            {destination.webPath ? (
              <Button asChild variant="secondary" size="lg" className="min-h-11 w-full">
                <a href={destination.webPath} data-testid="view-task-button">
                  {t('view_task')}
                </a>
              </Button>
            ) : null}
            <p className="mt-2 text-xs leading-5 text-text-muted">{t('browser_hint')}</p>
            <div
              data-testid="wework-install-hint"
              className="rounded-xl border border-border bg-base p-3"
            >
              <p className="text-sm font-medium text-text-primary">{t('not_installed_title')}</p>
              <p className="mt-1 text-xs leading-5 text-text-secondary">
                {t('not_installed_description')}
              </p>
              <Button asChild variant="secondary" size="sm" className="mt-3 min-h-11">
                <a
                  href={WEWORK_DOWNLOAD_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="download-wework-button"
                >
                  {t('download_wework')}
                </a>
              </Button>
            </div>
          </div>
        )}
      </section>
    </main>
  )
}

export default function OpenWeworkPage() {
  return (
    <Suspense fallback={null}>
      <WeworkHandoffContent />
    </Suspense>
  )
}
