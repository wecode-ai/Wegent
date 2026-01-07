/**
 * Browser Detection Utility
 * Detects if the page is opened in an in-app browser (WeChat, DingTalk, etc.)
 */

export interface BrowserInfo {
  isInAppBrowser: boolean
  browserName?: string
  userAgent: string
}

/**
 * Detects if the current browser is an in-app browser
 * @returns BrowserInfo object with detection results
 */
export function detectInAppBrowser(): BrowserInfo {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return {
      isInAppBrowser: false,
      userAgent: '',
    }
  }

  const ua = navigator.userAgent.toLowerCase()

  // Common in-app browser patterns
  const inAppBrowserPatterns = [
    // Chinese apps
    { pattern: /micromessenger/i, name: 'WeChat' }, // 微信
    { pattern: /dingtalk/i, name: 'DingTalk' }, // 钉钉
    { pattern: /aliapp/i, name: 'Alipay' }, // 支付宝
    { pattern: /qq\/\d+/i, name: 'QQ' }, // QQ
    { pattern: /weibo/i, name: 'Weibo' }, // 微博
    { pattern: /douban/i, name: 'Douban' }, // 豆瓣
    { pattern: /xiaohongshu/i, name: 'XiaoHongShu' }, // 小红书

    // International apps
    { pattern: /fbav|fbios|fb_iab|fb4a/i, name: 'Facebook' },
    { pattern: /instagram/i, name: 'Instagram' },
    { pattern: /twitter/i, name: 'Twitter' },
    { pattern: /line/i, name: 'Line' },
    { pattern: /snapchat/i, name: 'Snapchat' },
    { pattern: /telegram/i, name: 'Telegram' },
    { pattern: /whatsapp/i, name: 'WhatsApp' },
    { pattern: /linkedin/i, name: 'LinkedIn' },

    // Other patterns
    { pattern: /\bgsasafari\b/i, name: 'Google App' }, // Google App
    { pattern: /\bsafari.*webview\b/i, name: 'WebView' }, // Generic WebView
  ]

  for (const { pattern, name } of inAppBrowserPatterns) {
    if (pattern.test(ua)) {
      return {
        isInAppBrowser: true,
        browserName: name,
        userAgent: navigator.userAgent,
      }
    }
  }

  return {
    isInAppBrowser: false,
    userAgent: navigator.userAgent,
  }
}

/**
 * Gets instructions for opening in default browser based on detected app
 * @param browserName - The name of the detected in-app browser
 * @returns Instruction key for i18n
 */
export function getOpenInBrowserInstruction(browserName?: string): string {
  const instructionMap: Record<string, string> = {
    WeChat: 'wechat',
    DingTalk: 'dingtalk',
    Alipay: 'alipay',
    QQ: 'qq',
    Weibo: 'weibo',
    Facebook: 'facebook',
    Instagram: 'instagram',
    Twitter: 'twitter',
  }

  return instructionMap[browserName || ''] || 'default'
}
