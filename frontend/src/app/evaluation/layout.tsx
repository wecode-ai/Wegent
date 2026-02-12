// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { ReactNode } from 'react'
import Link from 'next/link'
import { FileCheck } from 'lucide-react'
import { UserProvider } from '@/features/common/UserContext'

function EvaluationHeader() {
  return (
    <header className="border-b border-border bg-surface">
      <div className="container mx-auto flex h-14 items-center justify-between px-4">
        <Link href="/evaluation" className="flex items-center gap-2">
          <FileCheck className="h-5 w-5 text-primary" />
          <span className="font-semibold text-text-primary">Evaluation</span>
        </Link>
        <nav className="flex items-center gap-4">
          <Link
            href="/evaluation/topics"
            className="text-sm text-text-secondary hover:text-text-primary"
          >
            Topics
          </Link>
          <Link
            href="/chat"
            className="text-sm text-text-secondary hover:text-text-primary"
          >
            Back to Chat
          </Link>
        </nav>
      </div>
    </header>
  )
}

export default function EvaluationLayout({ children }: { children: ReactNode }) {
  return (
    <UserProvider>
      <div className="flex min-h-screen flex-col bg-base">
        <EvaluationHeader />
        <main className="flex-1">{children}</main>
      </div>
    </UserProvider>
  )
}
