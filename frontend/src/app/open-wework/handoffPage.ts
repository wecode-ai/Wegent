import en from '@/i18n/locales/en/wework-open.json'
import zh from '@/i18n/locales/zh-CN/wework-open.json'

import { isDingTalkUserAgent, isMobileUserAgent, type WeworkHandoffDestination } from './handoff'

type HandoffLanguage = 'en' | 'zh'

interface WeworkHandoffPageOptions {
  acceptLanguage?: string
  destination: WeworkHandoffDestination | null
  userAgent?: string
}

export function resolveHandoffLanguage(acceptLanguage = ''): HandoffLanguage {
  return /^\s*en(?:-|,|;|$)/i.test(acceptLanguage) ? 'en' : 'zh'
}

export function renderWeworkHandoffPage({
  acceptLanguage,
  destination,
  userAgent = '',
}: WeworkHandoffPageOptions): string {
  const language = resolveHandoffLanguage(acceptLanguage)
  const copy = language === 'en' ? en : zh
  const dingTalk = isDingTalkUserAgent(userAgent)
  const mobile = isMobileUserAgent(userAgent)
  const title = destination ? (dingTalk ? copy.dingtalk_title : copy.title) : copy.invalid_title
  const description = destination
    ? dingTalk
      ? copy.dingtalk_description
      : copy.description
    : copy.invalid_description
  const hint = destination ? (dingTalk ? copy.dingtalk_hint : copy.browser_hint) : ''
  const action = destination
    ? dingTalk
      ? `<div class="steps" data-testid="dingtalk-browser-hint">
          <p class="step">1. ${escapeHtml(copy.dingtalk_step_menu)}</p>
          <p class="step">2. ${escapeHtml(copy.dingtalk_step_browser)}</p>
        </div>`
      : `<a class="button primary" href="${escapeHtml(destination.weworkUrl)}" data-testid="open-wework-button">${escapeHtml(copy.open_wework)}</a>`
    : ''
  const webAction = destination
    ? `<a class="button secondary" href="${escapeHtml(destination.webPath)}" data-testid="view-task-button">${escapeHtml(copy.view_task)}</a>`
    : ''
  const autoLaunch =
    destination && !mobile
      ? `<script>
  window.setTimeout(function () {
    window.location.href = ${escapeScriptValue(destination.weworkUrl)};
  }, 50);
</script>`
      : ''

  return `<!doctype html>
<html lang="${language === 'en' ? 'en' : 'zh-CN'}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="color-scheme" content="light dark" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: #f5f7fb; color: #172033; }
      main { width: min(100%, 420px); border: 1px solid #dfe5ef; border-radius: 20px; background: #fff; padding: 24px; box-shadow: 0 18px 50px rgba(35, 52, 88, .12); }
      .brand { margin: 0; color: #2563eb; font-size: 13px; font-weight: 700; }
      h1 { margin: 12px 0 0; font-size: 26px; line-height: 1.25; }
      .description { margin: 12px 0 0; color: #5b6475; font-size: 15px; line-height: 1.7; }
      .actions { display: grid; gap: 12px; margin-top: 28px; }
      .button { display: flex; min-height: 48px; align-items: center; justify-content: center; border-radius: 14px; text-decoration: none; font-size: 16px; font-weight: 600; }
      .primary { background: #111827; color: #fff; }
      .secondary { border: 1px solid #d7deea; background: #fff; color: #172033; }
      .steps { display: grid; gap: 10px; border-radius: 14px; background: #f2f6ff; padding: 16px; }
      .step { margin: 0; color: #263a64; font-size: 15px; line-height: 1.6; }
      .hint { margin: 4px 0 0; color: #7a8496; font-size: 12px; line-height: 1.6; }
      @media (prefers-color-scheme: dark) {
        body { background: #0f1420; color: #eef2f9; }
        main { border-color: #2b3445; background: #171e2b; box-shadow: none; }
        .description, .hint { color: #aab4c5; }
        .secondary { border-color: #354054; background: #1d2534; color: #eef2f9; }
        .steps { background: #1c2a45; }
        .step { color: #d7e3ff; }
      }
    </style>
  </head>
  <body>
    <main>
      <p class="brand">${escapeHtml(copy.brand)}</p>
      <h1>${escapeHtml(title)}</h1>
      <p class="description">${escapeHtml(description)}</p>
      <div class="actions">
        ${action}
        ${webAction}
        ${hint ? `<p class="hint">${escapeHtml(hint)}</p>` : ''}
      </div>
    </main>
    ${autoLaunch}
  </body>
</html>`
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function escapeScriptValue(value: string): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c')
}
