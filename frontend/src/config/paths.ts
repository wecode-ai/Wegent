// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { getRuntimeConfigSync } from '@/lib/runtime-config'

export const paths = {
  home: {
    getHref: () => '/',
  },
  docs: {
    getHref: () => getRuntimeConfigSync().docsUrl,
  },
  auth: {
    password_login: {
      getHref: () => '/login',
    },
    login: {
      getHref: () => {
        console.log(typeof window === 'undefined')
        // Always return local login page in SSR/Node environment
        return paths.auth.password_login.getHref()
      },
    },
  },
  chat: {
    getHref: () => '/chat',
  },
  code: {
    getHref: () => '/code',
  },
  wiki: {
    getHref: () => '/knowledge',
  },
  devices: {
    getHref: () => '/devices',
  },
  feed: {
    getHref: () => '/feed',
  },
  feedSubscriptions: {
    getHref: () => '/feed/subscriptions',
  },
  feedSubscriptionDetail: {
    getHref: (id: number | string) => `/feed/subscriptions/${id}`,
  },
  feedInvitations: {
    getHref: () => '/feed/invitations',
  },
  settings: {
    root: {
      getHref: () => '/settings',
    },
    integrations: {
      getHref: () => '/settings?tab=integrations',
    },
    bot: {
      getHref: () => '/settings?tab=bot',
    },
    team: {
      getHref: () => '/settings?tab=team',
    },
    models: {
      getHref: () => '/settings?tab=models',
    },
  },
} as const
