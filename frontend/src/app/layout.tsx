// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from 'next'
import './globals.css'
import 'antd/dist/reset.css'
import '@/features/common/scrollbar.css'
import MockInit from '@/features/mock/MockInit'
import AntdProvider from './AntdProvider'
import AuthGuard from '@/features/common/AuthGuard'
import I18nProvider from '@/components/I18nProvider'
import { ThemeProvider } from '@/features/theme/ThemeProvider'
import { ThemeScript } from '@/features/theme/ThemeScript'

export const metadata: Metadata = {
  title: 'WeCode AI Assistant',
  description: 'AI-powered assistant for development tasks',
  icons: {
    icon: '/weibo-logo.png',
    shortcut: '/weibo-logo.png',
    apple: '/weibo-logo.png',
  },
}

export const viewport = {
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body className="font-sans antialiased bg-base text-text-primary" suppressHydrationWarning>
        <ThemeProvider>
          <MockInit>
            <I18nProvider>
              <AntdProvider>
                <AuthGuard>
                  {children}
                </AuthGuard>
              </AntdProvider>
            </I18nProvider>
          </MockInit>
        </ThemeProvider>
      </body>
    </html>
  )
}
