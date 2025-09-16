// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export const paths = {
    home: {
        getHref: () => '/',
    },
    auth: {
        login: {
            getHref: () => {
                console.log(typeof window === 'undefined');
                // SSR/Node 环境下始终返回本地登录页
                if (typeof window === 'undefined') return '/login'
                const isInternal = process.env.NEXT_PUBLIC_ENV_INTERNAL_DEPLOYMENT === 'true'
                if (isInternal) {
                    return 'https://cas.erp.sina.com.cn/cas/login?service=' + encodeURIComponent(paths.internal.casService.getHref())
                }
                return '/login'
            },
        },
    },
    task: {
        getHref: () => '/tasks',
    },
    dashboard: {
        root: {
            getHref: () => '/dashboard',
        },
        integrations: {
            getHref: () => '/dashboard',
        },
        bot: {
            getHref: () => '/dashboard?tab=bot',
        },
        team: {
            getHref: () => '/dashboard?tab=team',
        },
    },
    internal: {
        cas: {
            getHref: () => '/login/internal/cas',
        },
        casService: {
            getHref: () => {
                if (typeof window === 'undefined') return ''
                return window.location.origin + paths.internal.cas.getHref()
            }
        }
    },
} as const;
