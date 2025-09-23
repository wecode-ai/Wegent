'use client'

import { useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Spin } from 'antd'
import { paths } from '@/config/paths'
import { loginWithOidcToken } from '@/apis/user'

export default function OidcCallbackPage() {
    const router = useRouter()
    const searchParams = useSearchParams()
    
    console.log('OIDC callback page - searchParams:', searchParams.toString());
    
    useEffect(() => {
        // Check if token parameters already exist (redirected from backend)
        const accessToken = searchParams.get('access_token')
        const tokenType = searchParams.get('token_type')
        const loginSuccess = searchParams.get('login_success')
        
        console.log('OIDC callback page - params:', {
            accessToken: !!accessToken,
            tokenType,
            loginSuccess
        });
        
        if (accessToken && loginSuccess === 'true') {
            // Backend has completed OIDC authentication, processing token in the same way as CAS
            console.log('OIDC callback page - processing token with loginWithOidcToken');
            
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
        console.log('OIDC callback page - redirecting to backend for OIDC callback processing');
        window.location.href = `/api/auth/oidc/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`
        
    }, [router, searchParams])

    return (
        <div className="flex items-center justify-center min-h-screen bg-[#0d1117]">
            <div className="bg-[#161b22] rounded-xl px-8 py-8 flex flex-col items-center shadow-lg">
                <Spin size="large" />
                <div className="mt-4 text-gray-200 text-base font-medium tracking-wide">Processing OpenID Connect login...</div>
            </div>
        </div>
    )
}