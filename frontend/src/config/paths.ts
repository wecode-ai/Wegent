// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export const paths = {
    home: {
        getHref: () => '/',
    },
    auth: {
        login: {
            getHref: () => '/login',
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
    }
} as const;
