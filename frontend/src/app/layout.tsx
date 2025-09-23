// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react'
import type { Metadata } from 'next'
import './globals.css'
import 'antd/dist/reset.css'
import '@/features/common/scrollbar.css'
import MockInit from '@/features/mock/MockInit'
import AuthGuard from '@/features/common/AuthGuard'
import I18nProvider from '@/components/I18nProvider'
import AntdProvider from './AntdProvider'
import { ThemeProvider } from '@/features/theme/ThemeContext'

export const metadata: Metadata = {
  title: 'WeCode AI Assistant',
  description: 'AI-powered assistant for development tasks',
}

export default function RootLayout({
  children,
}: {
  children: ReactNode
}) {
  return (
    <html lang="en" data-theme="dark">
      <body className="font-sans antialiased bg-theme-app text-theme-primary transition-colors">
        <MockInit>
          <I18nProvider>
            <ThemeProvider>
              <AntdProvider>
                <AuthGuard>{children}</AuthGuard>
              </AntdProvider>
            </ThemeProvider>
          </I18nProvider>
        </MockInit>
      </body>
    </html>
  )
}
