// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useRouter } from 'next/navigation'
import { Button } from '@headlessui/react'
import { useUser } from '@/features/common/UserContext'
import { paths } from '@/config/paths'

export default function Home() {
  const router = useRouter()

  const { user } = useUser()
  const handleGetStarted = () => {
    if (user) {
      router.replace(paths.task.getHref())
    } else {
      router.push(paths.auth.login.getHref())
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-8 bg-[#0d1117]">
      <div className="w-full max-w-2xl text-center">
        <h1 className="text-5xl font-medium text-white mb-4">
          WeCode AI Assistant
        </h1>
        <p className="text-xl text-gray-400 mb-12 font-light">
          Your AI-powered development assistant
        </p>
        <Button
          onClick={handleGetStarted}
          className="inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-white rounded-md focus:outline-none focus:outline-white/25 focus:border-transparent transition-colors duration-200"
          style={{ backgroundColor: 'rgb(112,167,215)' }}
        >
          Get Start!
        </Button>
      </div>
    </main>
  )
}