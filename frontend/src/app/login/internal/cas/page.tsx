'use client'

import { useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { loginWithTicket } from '@/apis/internal/user'
import { Spin } from 'antd'
import { paths } from '@/config/paths'

export default function CasCallbackPage() {
    const router = useRouter()
    const searchParams = useSearchParams()
    console.log('searchParams:', searchParams.toString());
    useEffect(() => {
        const ticket = searchParams.get('ticket')
        if (!ticket) {
            // 无 ticket，跳转首页
            router.replace(paths.home.getHref())
            return
        }
        // ticket 换 token，service 用 tasks 页 URL
        loginWithTicket(ticket)
            .then(() => {
                router.replace(paths.task.getHref())
            })
            .catch(() => {
                // 登录失败，跳转登录页
                router.replace(paths.home.getHref())
            })
    }, [router, searchParams])

    return (
        <div className="flex items-center justify-center min-h-screen bg-[#0d1117]">
            <div className="bg-[#161b22] rounded-xl px-8 py-8 flex flex-col items-center shadow-lg">
                <Spin size="large" />
                <div className="mt-4 text-gray-200 text-base font-medium tracking-wide">Logining...</div>
            </div>
        </div>
    )
}