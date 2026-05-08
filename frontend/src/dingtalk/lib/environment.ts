// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * DingTalk environment detection and redirect utilities.
 */
import { isDingTalkEnvironment } from './dingtalk-sdk'

export interface DingTalkConfig {
  corpId: string
  clientId: string
  agentId: string
  fallbackUrl: string
}

export function getDingTalkConfig(): DingTalkConfig {
  return {
    corpId: process.env.NEXT_PUBLIC_DINGTALK_CORP_ID || '',
    clientId: process.env.NEXT_PUBLIC_DINGTALK_CLIENT_ID || '',
    agentId: process.env.NEXT_PUBLIC_DINGTALK_AGENT_ID || '',
    fallbackUrl:
      process.env.NEXT_PUBLIC_DINGTALK_FALLBACK_URL ||
      'https://github.com/aspect-build/wegent',
  }
}

export function isAuthModeDingTalk(): boolean {
  return process.env.NEXT_PUBLIC_AUTH_MODE === 'dingtalk'
}

export async function redirectIfNotDingTalk(): Promise<boolean> {
  const config = getDingTalkConfig()
  const inDingTalk = await isDingTalkEnvironment()

  if (!inDingTalk) {
    window.location.href = config.fallbackUrl
    return true // Redirected
  }

  return false // Not redirected
}
