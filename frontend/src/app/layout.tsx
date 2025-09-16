// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from 'next'
import './globals.css'
import 'antd/dist/reset.css'
import MockInit from '@/features/mock/MockInit'
import { ToastContainer, Slide } from 'react-toastify'
import 'react-toastify/dist/ReactToastify.css'
import AntdProvider from './AntdProvider'
import AuthGuard from '@/features/common/AuthGuard'

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
          <AntdProvider>
            <AuthGuard>
              {children}
            </AuthGuard>
          </AntdProvider>
        </MockInit>
        <ToastContainer
          position="top-center"
          autoClose={2000}
          hideProgressBar
          newestOnTop={false}
          closeOnClick
          rtl={false}
          pauseOnFocusLoss
          draggable
          pauseOnHover
          theme="dark"
          transition={Slide}
        />
      </body>
    </html>
  )
}