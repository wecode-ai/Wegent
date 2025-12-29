// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * DingTalk JS SDK wrapper.
 * Encapsulates all DingTalk-specific logic.
 */

// Dynamic import to avoid SSR issues
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let dd: any = null

async function loadDingTalkSDK() {
  if (typeof window === 'undefined') return null
  if (dd) return dd
  dd = await import('dingtalk-jsapi')
  return dd
}

export type DingTalkPlatform = 'notInDingTalk' | 'android' | 'ios' | 'pc'

export async function getDingTalkPlatform(): Promise<DingTalkPlatform> {
  const sdk = await loadDingTalkSDK()
  if (!sdk) return 'notInDingTalk'
  return sdk.env.platform as DingTalkPlatform
}

export async function isDingTalkEnvironment(): Promise<boolean> {
  const platform = await getDingTalkPlatform()
  return platform !== 'notInDingTalk'
}

export async function requestAuthCode(
  corpId: string,
  clientId: string
): Promise<string> {
  const sdk = await loadDingTalkSDK()
  if (!sdk) {
    throw new Error('DingTalk SDK not available')
  }

  return new Promise((resolve, reject) => {
    sdk.requestAuthCode({
      corpId,
      clientId,
      onSuccess: (result: { code: string }) => resolve(result.code),
      onFail: (err: Error) => reject(err),
    })
  })
}
