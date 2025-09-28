// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Spin } from 'antd'
import { paths } from '@/config/paths'
import { loginWithOidcToken } from '@/apis/user'

export default function OidcCallbackPage() {
    const router = useRouter()
    const searchParams = useSearchParams()
        
    useEffect(() => {
        // Check if token parameters already exist (redirected from backend)
        const accessToken = searchParams.get('access_token')
        const tokenType = searchParams.get('token_type')
        const loginSuccess = searchParams.get('login_success')
        
        if (accessToken && loginSuccess === 'true') {
            // Backend has completed OIDC authentication, processing token in the same way as CAS
            
            loginWithOidcToken(accessToken)
                .then(() => {
                    console.log('OIDC callback page - token processed successfully, redirecting to task page');
                    router.replace(paths.task.getHref())
                })
                .catch((error) => {
                    console.error('OIDC callback page - token processing failed:', error);
                    router.replace(paths.home.getHref())
                })
            return
        }
        
        // If no token parameters, check code and state (frontend needs to handle OIDC callback)
        const code = searchParams.get('code')
        const state = searchParams.get('state')
        const error = searchParams.get('error')
        
        if (error) {
            console.error('OIDC login error:', error)
            router.replace(paths.home.getHref())
            return
        }
        
        if (!code || !state) {
            console.error('OIDC callback parameters missing')
            router.replace(paths.home.getHref())
            return
        }
        
        // If code and state exist, redirect to backend to handle OIDC callback
        window.location.href = `/api/auth/oidc/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`
        
    }, [router, searchParams])

    return (
        <div className="flex items-center justify-center min-h-screen bg-base">
            <div className="bg-surface rounded-xl px-8 py-8 flex flex-col items-center shadow-lg">
                <Spin size="large" />
                <div className="mt-4 text-text-secondary text-base font-medium tracking-wide">Processing OpenID Connect login...</div>
            </div>
        </div>
    )
}
