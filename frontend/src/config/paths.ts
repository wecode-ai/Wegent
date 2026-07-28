// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { getRuntimeConfigSync } from '@/lib/runtime-config'
import { buildChatCodeHref, getCodingEntryHref } from '@/config/coding-route'

export const paths = {
  home: {
    getHref: () => '/',
  },
  docs: {
    getHref: () => getRuntimeConfigSync().docsUrl,
  },
  auth: {
    wework_authorize: {
      getHref: () => '/auth/wework/authorize',
    },
    password_login: {
      getHref: () => '/login',
    },
    login: {
      getHref: () => {
        // Always return local login page in SSR/Node environment
        return paths.auth.password_login.getHref()
      },
    },
  },
  chat: {
    getHref: () => '/chat',
    getCodeHref: () => buildChatCodeHref(),
  },
  code: {
    getHref: () => getCodingEntryHref(),
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
  inbox: {
    getHref: () => '/inbox',
  },
  resourceLibrary: {
    getHref: () => '/resource-library',
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
  generate: {
    getHref: () => '/generate',
  },
  settings: {
    root: {
      getHref: () => '/settings',
    },
    integrations: {
      getHref: () => '/settings?tab=integrations',
    },
    bot: {
      getHref: () => '/resource-library?tab=mine&type=agent&scope=personal',
    },
    team: {
      getHref: () => '/resource-library?tab=mine&type=agent&scope=personal',
    },
    models: {
      getHref: () => '/resource-library?tab=mine&type=model&scope=personal',
    },
    groupManager: {
      getHref: () => '/settings?tab=group-manager',
    },
  },
} as const
