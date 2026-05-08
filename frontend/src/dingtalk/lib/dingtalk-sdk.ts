// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * DingTalk JS SDK wrapper.
 * Encapsulates all DingTalk-specific logic.
 */

import { getDingTalkConfig } from './environment'

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

/**
 * JSAPI sign data returned from backend.
 * Only timeStamp and signature come from backend;
 * other dd.config params are read from frontend env vars.
 */
export interface JsapiSignData {
  timeStamp: number
  signature: string
}

/** Fixed nonce string used for JSAPI signature (must match backend). */
const JSAPI_NONCE_STR = 'ISEEDEADPEOPLE'

/** JSAPI list for dd.config authorization. */
const JSAPI_LIST = [
  'biz.contact.choose',
  'device.base.getUUID',
  'device.audio.startRecord',
  'device.audio.stopRecord',
  'device.audio.onRecordEnd',
  'device.audio.translateVoice',
  'media.voiceRecorder.start',
  'media.voiceRecorder.stop',
]

/**
 * Configure dd.config with JSAPI signature for audio recording APIs.
 * Must be called before using device.audio.* APIs.
 *
 * agentId and corpId are read from getDingTalkConfig();
 * only timeStamp and signature come from the backend.
 */
export async function configureDingTalkJsapi(signData: JsapiSignData): Promise<void> {
  const sdk = await loadDingTalkSDK();
  if (!sdk) {
    throw new Error('DingTalk SDK not available');
  }

  const { agentId, corpId } = getDingTalkConfig()

  return new Promise((resolve, reject) => {
    sdk.error((err: unknown) => {
      //console.info('[DingTalk] agentId:' + agentId + 'corpId:' + corpId);
      //console.info('[DingTalk] timeStamp:' + signData.timeStamp + 'signature:' + signData.signature);
      console.error('[DingTalk] dd.config error in sdk.error :', err);
      reject(new Error(`dd.config error reject by sdk.error: ${JSON.stringify(err)}`));
    });

    sdk.ready(() => {
      //console.info('[DingTalk] agentId:' + agentId + 'corpId:' + corpId);
      console.error('[DingTalk] dd.config ready');
      resolve();
    });

    try {
      sdk.config({
        agentId,
        corpId,
        timeStamp: signData.timeStamp,
        nonceStr: JSAPI_NONCE_STR,
        signature: signData.signature,
        type: 0,
        jsApiList: JSAPI_LIST,
        debug: true // 开启调试
      });
    } catch (err) {
      console.error('[DingTalk] sdk.config threw an exception:', err);
      reject(new Error(`sdk.config exception: ${JSON.stringify(err)}`));
    }
  });
}

export interface AudioRecordResult {
  mediaId: string
  duration: number
}

/**
 * Check if DingTalk audio recording APIs are supported on the current platform.
 */
export async function isDingTalkAudioSupported(): Promise<boolean> {
  const isDingTalk = await isDingTalkEnvironment();
  if (!isDingTalk) return false;

  const sdk = await loadDingTalkSDK();
  if (!sdk) return false;

  try {
    // Check if the required audio APIs exist on the sdk object
    return (
      typeof sdk.device?.audio?.startRecord === 'function' &&
      typeof sdk.device?.audio?.stopRecord === 'function' &&
      typeof sdk.device?.audio?.translateVoice === 'function'
    );
  } catch {
    return false;
  }
}

/**
 * Start audio recording via DingTalk JSAPI.
 */
export async function startDingTalkRecord(maxDuration = 300): Promise<void> {
  const sdk = await loadDingTalkSDK();
  if (!sdk) throw new Error('DingTalk SDK not available');

  return new Promise((resolve, reject) => {
    sdk.device.audio.startRecord({
      maxDuration,
      onSuccess: () => {
        console.log('[DingTalk] startRecord success');
        resolve();
      },
      onFail: (err: unknown) => {
        console.error('[DingTalk] startRecord fail:', err);
        reject(new Error(`startRecord failed: ${JSON.stringify(err)}`));
      },
    });
  });
}

/**
 * Stop audio recording via DingTalk JSAPI.
 * Returns the mediaId and duration of the recorded audio.
 */
export async function stopDingTalkRecord(): Promise<AudioRecordResult> {
  const sdk = await loadDingTalkSDK();
  if (!sdk) throw new Error('DingTalk SDK not available');

  return new Promise((resolve, reject) => {
    sdk.device.audio.stopRecord({
      onSuccess: (res: AudioRecordResult) => {
        console.log('[DingTalk] stopRecord success, mediaId:', res.mediaId);
        resolve(res);
      },
      onFail: (err: unknown) => {
        console.error('[DingTalk] stopRecord fail:', err);
        reject(new Error(`stopRecord failed: ${JSON.stringify(err)}`));
      },
    });
  });
}

/**
 * Translate voice recording to text via DingTalk JSAPI.
 */
export async function translateDingTalkVoice(
  mediaId: string,
  duration: number
): Promise<string> {
  const sdk = await loadDingTalkSDK();
  if (!sdk) throw new Error('DingTalk SDK not available');

  return new Promise((resolve, reject) => {
    sdk.device.audio.translateVoice({
      mediaId,
      duration,
      onSuccess: (res: { content: string }) => {
        console.log('[DingTalk] translateVoice success:', res.content);
        resolve(res.content);
      },
      onFail: (err: unknown) => {
        console.error('[DingTalk] translateVoice fail:', err);
        reject(new Error(`translateVoice failed: ${JSON.stringify(err)}`));
      },
    });
  });
}
