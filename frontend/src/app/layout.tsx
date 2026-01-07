// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from 'next'
import './globals.css'
import '@/features/common/scrollbar.css'
import MockInit from '@/features/mock/MockInit'
import AuthGuard from '@/features/common/AuthGuard'
import I18nProvider from '@/components/I18nProvider'
import { ThemeProvider } from '@/features/theme/ThemeProvider'
import { ThemeScript } from '@/features/theme/ThemeScript'
import ErrorBoundary from '@/features/common/ErrorBoundary'
import ServiceWorkerRegistration from '@/components/ServiceWorkerRegistration'
import TelemetryInit from '@/components/TelemetryInit'
import RuntimeConfigInit from '@/components/RuntimeConfigInit'
import { Toaster } from '@/components/ui/toaster'
import { Toaster as SonnerToaster } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'

export const metadata: Metadata = {
  title: 'Wegent AI',
  description: 'AI-powered assistant in browser.',
  icons: {
    icon: '/weibo-logo.png',
    shortcut: '/weibo-logo.png',
    apple: '/weibo-logo.png',
  },
}

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" translate="no" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body className="font-sans antialiased bg-base text-text-primary" suppressHydrationWarning>
        <ServiceWorkerRegistration />
        <TelemetryInit />
        <ErrorBoundary>
          <ThemeProvider>
            <TooltipProvider>
              <RuntimeConfigInit>
                <MockInit>
                  <I18nProvider>
                    <AuthGuard>{children}</AuthGuard>
                  </I18nProvider>
                </MockInit>
              </RuntimeConfigInit>
            </TooltipProvider>
          </ThemeProvider>
        </ErrorBoundary>
        <Toaster />
        <SonnerToaster position="top-center" />
      </body>
    </html>
  )
}
