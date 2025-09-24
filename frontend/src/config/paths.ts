// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export const paths = {
    home: {
        getHref: () => '/',
    },
    auth: {
        password_login: {
            getHref: () => '/login',
        },
        login: {
            getHref: () => {
                console.log(typeof window === 'undefined');
                // SSR/Node 环境下始终返回本地登录页
                return paths.auth.password_login.getHref()
            },
        },
    },
    task: {
        getHref: () => '/tasks',
    },
    settings: {
        root: {
            getHref: () => '/settings',
        },
        integrations: {
            getHref: () => '/settings',
        },
        bot: {
            getHref: () => '/settings?tab=bot',
        },
        team: {
            getHref: () => '/settings?tab=team',
        },
    },
} as const;
