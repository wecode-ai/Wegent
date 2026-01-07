'use client'

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { detectInAppBrowser, getOpenInBrowserInstruction } from '@/utils/browserDetection'
import { Globe, ExternalLink, ChevronRight } from 'lucide-react'

interface InAppBrowserGuardProps {
  onProceed?: () => void
  onCancel?: () => void
}

/**
 * Modal that detects in-app browsers and prompts users to open in default browser
 * Shows a full-screen overlay with instructions when triggered
 */
export function InAppBrowserGuard({ onProceed }: InAppBrowserGuardProps) {
  const { t } = useTranslation()
  const [isDismissed, setIsDismissed] = useState(false)

  // Get browser info
  const browserInfo = detectInAppBrowser()

  // If dismissed or not in-app browser, don't show anything
  if (isDismissed || !browserInfo.isInAppBrowser) {
    return null
  }

  const handleContinueAnyway = () => {
    setIsDismissed(true)
    onProceed?.()
  }

  const instructionKey = getOpenInBrowserInstruction(browserInfo.browserName)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-gray-900 dark:to-gray-800 p-4">
      <div className="w-full max-w-md">
        {/* Icon and Title */}
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-white dark:bg-gray-800 shadow-lg">
            <Globe className="h-10 w-10 text-blue-600" />
          </div>
          <h1 className="mb-2 text-2xl font-bold text-gray-900 dark:text-gray-100">
            {t('inAppBrowser.title')}
          </h1>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {browserInfo.browserName
              ? t('inAppBrowser.detectedApp', { app: browserInfo.browserName })
              : t('inAppBrowser.detectedGeneric')}
          </p>
        </div>

        {/* Main Card */}
        <div className="rounded-2xl bg-white dark:bg-gray-800 p-6 shadow-xl">
          {/* Reason */}
          <div className="mb-6">
            <h2 className="mb-2 flex items-center text-lg font-semibold text-gray-900 dark:text-gray-100">
              <ExternalLink className="mr-2 h-5 w-5 text-blue-600" />
              {t('inAppBrowser.whyTitle')}
            </h2>
            <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-400">
              {t('inAppBrowser.whyDescription')}
            </p>
          </div>

          {/* Instructions */}
          <div className="mb-6 rounded-lg bg-blue-50 dark:bg-blue-900/20 p-4">
            <h3 className="mb-3 text-sm font-semibold text-gray-900 dark:text-gray-100">
              {t('inAppBrowser.howToOpen')}
            </h3>
            <ol className="space-y-2 text-sm text-gray-700 dark:text-gray-300">
              {t(`inAppBrowser.instructions.${instructionKey}`, {
                returnObjects: true,
              }) instanceof Array ? (
                (
                  t(`inAppBrowser.instructions.${instructionKey}`, {
                    returnObjects: true,
                  }) as string[]
                ).map((step, index) => (
                  <li key={index} className="flex items-start">
                    <ChevronRight className="mr-2 mt-0.5 h-4 w-4 flex-shrink-0 text-blue-600" />
                    <span>{step}</span>
                  </li>
                ))
              ) : (
                <li className="flex items-start">
                  <ChevronRight className="mr-2 mt-0.5 h-4 w-4 flex-shrink-0 text-blue-600" />
                  <span>{t(`inAppBrowser.instructions.${instructionKey}`)}</span>
                </li>
              )}
            </ol>
          </div>

          {/* Copy URL Button */}
          <button
            onClick={() => {
              if (typeof window !== 'undefined') {
                navigator.clipboard
                  .writeText(window.location.href)
                  .then(() => {
                    alert(t('inAppBrowser.urlCopied'))
                  })
                  .catch(() => {
                    alert(t('inAppBrowser.copyFailed'))
                  })
              }
            }}
            className="w-full rounded-lg bg-blue-600 px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-blue-700 active:bg-blue-800"
          >
            {t('inAppBrowser.copyUrl')}
          </button>

          {/* Alternative: Continue anyway (not recommended) */}
          <button
            onClick={handleContinueAnyway}
            className="mt-3 w-full text-center text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          >
            {t('inAppBrowser.continueAnyway')}
          </button>
        </div>

        {/* Footer Note */}
        <p className="mt-4 text-center text-xs text-gray-500 dark:text-gray-400">
          {t('inAppBrowser.footerNote')}
        </p>
      </div>
    </div>
  )
}
