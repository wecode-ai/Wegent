'use client'

import { Suspense, useEffect, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import { parseWeworkScheme } from '@wegent/chat-core'
import { getRuntimeConfigSync } from '@/lib/runtime-config'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'

function WeworkOpenContent() {
  const { t } = useTranslation('common')
  const { weworkAppName: appName } = getRuntimeConfigSync()
  const searchParams = useSearchParams()
  const destinations = searchParams.getAll('destination')
  const destination = destinations.length === 1 ? destinations[0] : ''
  const valid = destination.length <= 2048 && parseWeworkScheme(destination) !== null
  const launchedDestination = useRef<string | null>(null)

  useEffect(() => {
    if (!valid || launchedDestination.current === destination) return
    launchedDestination.current = destination
    window.location.assign(destination)
  }, [destination, valid])

  return (
    <main className="flex min-h-screen items-center justify-center bg-base p-6">
      <section className="w-full max-w-md space-y-6 rounded-xl border border-border bg-surface p-8">
        <h1 className="text-2xl font-semibold">{t('wework_open.title', { appName })}</h1>
        {valid ? (
          <>
            <p className="text-text-secondary">{t('wework_open.description', { appName })}</p>
            <Button asChild variant="primary" className="min-h-11 w-full">
              <a href={destination} data-testid="open-wework">
                {t('wework_open.open', { appName })}
              </a>
            </Button>
            <p className="text-sm text-text-secondary">{t('wework_open.hint', { appName })}</p>
          </>
        ) : (
          <p role="alert" data-testid="open-wework-invalid">
            {t('wework_open.invalid')}
          </p>
        )}
      </section>
    </main>
  )
}

export default function WeworkOpenPage() {
  return (
    <Suspense>
      <WeworkOpenContent />
    </Suspense>
  )
}
