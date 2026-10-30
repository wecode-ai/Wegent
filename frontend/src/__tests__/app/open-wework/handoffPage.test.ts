import { parseWeworkHandoff } from '@/app/open-wework/handoff'
import { renderWeworkHandoffPage } from '@/app/open-wework/handoffPage'

const destination = parseWeworkHandoff(new URLSearchParams({ projectId: '12', itemId: 'ISSUE-1' }))!

describe('renderWeworkHandoffPage', () => {
  it('renders static DingTalk instructions without a frontend bundle', () => {
    const html = renderWeworkHandoffPage({
      destination,
      userAgent: 'Mozilla/5.0 (Linux; Android 15) AliApp(DingTalk/7.6.0)',
    })

    expect(html).toContain('请在浏览器中打开')
    expect(html).toContain('data-testid="dingtalk-browser-hint"')
    expect(html).toContain('在浏览器打开')
    expect(html).not.toContain('data-testid="open-wework-button"')
    expect(html).not.toContain('_next')
    expect(html).not.toContain('<script src=')
  })

  it('renders the Wework action in an external browser', () => {
    const html = renderWeworkHandoffPage({
      destination,
      userAgent: 'Mozilla/5.0 (Linux; Android 15) Chrome/140.0.0.0 Mobile Safari/537.36',
    })

    expect(html).toContain('data-testid="open-wework-button"')
    expect(html).toContain('href="wegent://boards/12/issues/ISSUE-1"')
    expect(html).toContain('data-fallback-url="wework://boards/12/issues/ISSUE-1"')
    expect(html).not.toContain('data-testid="dingtalk-browser-hint"')
  })

  it('renders English copy for an English browser locale', () => {
    const html = renderWeworkHandoffPage({
      acceptLanguage: 'en-US,en;q=0.9',
      destination,
      userAgent: 'Mozilla/5.0 (Linux; Android 15) AliApp(DingTalk/7.6.0)',
    })

    expect(html).toContain('Open this page in a browser')
    expect(html).toContain('Choose Open in browser')
  })
})
