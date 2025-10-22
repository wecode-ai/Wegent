// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import LogoHeader, { LogoSubTitle } from '@/features/login/components/LogoHeader'
import LoginForm from '@/features/login/components/LoginForm'

import { UserProvider } from '@/features/common/UserContext'

export default function LoginPage() {
  return (
    <UserProvider>
      <div className="smart-h-screen bg-base flex flex-col justify-center py-12 sm:px-6 lg:px-8 box-border">
        <div className="sm:mx-auto sm:w-full sm:max-w-md">
          <LogoHeader />
          <LogoSubTitle />
        </div>
        <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
          <div className="bg-surface border border-border py-8 px-4 shadow-xl rounded-xl sm:px-10">
            <LoginForm />
          </div>
        </div>
      </div>
    </UserProvider>
  )
}
