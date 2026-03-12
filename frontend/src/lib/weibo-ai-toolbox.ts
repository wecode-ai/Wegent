// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { RuntimeConfig } from './runtime-config'

export type ClientOs = 'macos' | 'windows' | 'linux' | 'other'

type ToolboxRuntimeConfig = Pick<
  RuntimeConfig,
  'weiboAiToolboxMacDownloadUrl' | 'weiboAiToolboxWindowsDownloadUrl'
>

interface ToolboxDownloadUrlOptions {
  clientOs?: ClientOs
  fallbackForUnsupportedOs?: boolean
}

export function detectClientOs(): ClientOs {
  if (typeof navigator === 'undefined') {
    return 'other'
  }

  const platform = `${navigator.platform} ${navigator.userAgent}`.toLowerCase()

  if (platform.includes('win')) {
    return 'windows'
  }

  if (/mac|iphone|ipad|ipod/.test(platform)) {
    return 'macos'
  }

  if (platform.includes('linux') || platform.includes('x11')) {
    return 'linux'
  }

  return 'other'
}

export function isWeiboAiToolboxSupportedOs(clientOs: ClientOs): boolean {
  return clientOs === 'macos' || clientOs === 'windows'
}

export function getWeiboAiToolboxDownloadUrl(
  config: ToolboxRuntimeConfig,
  options: ToolboxDownloadUrlOptions = {}
): string {
  const clientOs = options.clientOs ?? detectClientOs()
  const fallbackForUnsupportedOs = options.fallbackForUnsupportedOs ?? true
  const macUrl = config.weiboAiToolboxMacDownloadUrl
  const windowsUrl = config.weiboAiToolboxWindowsDownloadUrl

  if (clientOs === 'windows') {
    return windowsUrl || macUrl
  }

  if (clientOs === 'macos') {
    return macUrl || windowsUrl
  }

  if (!fallbackForUnsupportedOs) {
    return ''
  }

  return macUrl || windowsUrl
}
