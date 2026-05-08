// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * DingTalk authentication module exports.
 */
export {
  isDingTalkEnvironment,
  requestAuthCode,
  isDingTalkAudioSupported,
  configureDingTalkJsapi,
  startDingTalkRecord,
  stopDingTalkRecord,
  translateDingTalkVoice,
} from './lib/dingtalk-sdk'
export type { JsapiSignData, AudioRecordResult } from './lib/dingtalk-sdk'
export {
  getDingTalkConfig,
  isAuthModeDingTalk,
  redirectIfNotDingTalk,
} from './lib/environment'
export { useDingTalkAuth } from './hooks/useDingTalkAuth'
