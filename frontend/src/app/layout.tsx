// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from 'next'
import './globals.css'
import 'antd/dist/reset.css'
import MockInit from '@/features/mock/MockInit'
import AntdProvider from './AntdProvider'
import AuthGuard from '@/features/common/AuthGuard'
import I18nProvider from '@/components/I18nProvider'

export const metadata: Metadata = {
  title: 'WeCode AI Assistant',
  description: 'AI-powered assistant for development tasks',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">
        <MockInit>
          <I18nProvider>
            <AntdProvider>
              <AuthGuard>
                {children}
              </AuthGuard>
            </AntdProvider>
          </I18nProvider>
        </MockInit>
      </body>
    </html>
  )
}