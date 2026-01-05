// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * DingTalk JS SDK wrapper.
 * Encapsulates all DingTalk-specific logic.
 */

// Dynamic import to avoid SSR issues
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let dd: any = null;

async function loadDingTalkSDK() {
  if (typeof window === 'undefined') return null;
  if (dd) return dd;
  dd = await import('dingtalk-jsapi');
  return dd;
}

export type DingTalkPlatform = 'notInDingTalk' | 'android' | 'ios' | 'pc';

export async function getDingTalkPlatform(): Promise<DingTalkPlatform> {
  const sdk = await loadDingTalkSDK();
  if (!sdk) return 'notInDingTalk';
  return sdk.env.platform as DingTalkPlatform;
}

export async function isDingTalkEnvironment(): Promise<boolean> {
  const platform = await getDingTalkPlatform();
  return platform !== 'notInDingTalk';
}

// Track pending auth code request to prevent duplicates
let pendingAuthCodePromise: Promise<string> | null = null;

export async function requestAuthCode(corpId: string, clientId: string): Promise<string> {
  // Return existing promise if request is already in progress
  if (pendingAuthCodePromise) {
    console.log('[DingTalk] Auth code request already in progress, reusing');
    return pendingAuthCodePromise;
  }

  const sdk = await loadDingTalkSDK();
  if (!sdk) {
    throw new Error('DingTalk SDK not available');
  }

  pendingAuthCodePromise = new Promise((resolve, reject) => {
    let resolved = false; // Prevent multiple callbacks

    sdk.runtime.permission.requestAuthCode({
      corpId: corpId,
      clientId: clientId,
      onSuccess: (result: { code: string }) => {
        if (resolved) return;
        resolved = true;
        pendingAuthCodePromise = null;
        console.info(result);
        resolve(result.code);
      },
      onFail: (err: Error) => {
        if (resolved) return;
        resolved = true;
        pendingAuthCodePromise = null;
        reject(err);
      },
    });
  });

  return pendingAuthCodePromise;
}
