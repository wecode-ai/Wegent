import { beforeEach, describe, expect, it, vi } from 'vitest'

const ui = vi.hoisted(() => ({
  open: vi.fn().mockResolvedValue({ type: 'dismiss' }),
  confirm: vi.fn(),
  error: vi.fn(),
}))
vi.mock('expo-web-browser', () => ({ openBrowserAsync: ui.open }))
vi.mock('./errorAlerts', () => ({ confirmNativeAction: ui.confirm, showErrorAlert: ui.error }))

import {
  confirmModelDataSharing,
  MOBILE_PRIVACY_POLICY_URL,
  MODEL_DATA_SHARING_NOTICE,
  openPrivacyPolicy,
} from './privacyPolicy'

describe('model sharing disclosure', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('opens the public notice without relying on a configured Wegent Backend', async () => {
    await openPrivacyPolicy()
    expect(ui.open).toHaveBeenCalledWith(MOBILE_PRIVACY_POLICY_URL)
    expect(new URL(MOBILE_PRIVACY_POLICY_URL).protocol).toBe('https:')
    expect(ui.error).not.toHaveBeenCalled()
  })

  it('reports a browser failure through the existing native operation boundary', async () => {
    const cause = new Error('browser unavailable')
    ui.open.mockRejectedValueOnce(cause)
    await openPrivacyPolicy()
    expect(ui.error).toHaveBeenCalledWith(cause, { title: '无法打开隐私政策' })
  })

  it('opens the English public policy when that language is selected', async () => {
    await openPrivacyPolicy('en')
    expect(ui.open).toHaveBeenCalledWith(
      'https://github.com/wecode-ai/Wegent/blob/main/docs/en/wework/mobile-privacy.md'
    )
  })

  it('defers model configuration or login until explicit native confirmation', async () => {
    const operation = vi.fn().mockResolvedValue(undefined)
    confirmModelDataSharing(operation)
    expect(operation).not.toHaveBeenCalled()
    const [, message, options] = ui.confirm.mock.calls[0]!
    expect(message).toBe(MODEL_DATA_SHARING_NOTICE)
    expect(message).toContain('文件内容和工具输出')
    expect(options.confirmLabel).toBe('同意并继续')
    await options.onConfirm()
    expect(operation).toHaveBeenCalledOnce()
  })
})
