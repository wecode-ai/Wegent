// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitAccessCode } from '@wegent/chat-core/git-access'
import { createCollaborationTranslator } from '../i18n'
import {
  GitAccountConfigurationButton,
  GitAccountConfigurationProvider,
} from './GitAccountConfiguration'

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const openUrl = vi.fn()
function render({
  code = 'credentials-required',
  baseUrl = 'https://cloud.example/wegent?auth=private',
  enabled = true,
  configured = true,
  domain = 'git.example:8443',
  appearance = 'button',
}: {
  code?: GitAccessCode
  baseUrl?: string
  enabled?: boolean
  configured?: boolean
  domain?: string
  appearance?: 'button' | 'text'
} = {}) {
  act(() => {
    root.render(
      <GitAccountConfigurationProvider value={configured ? { baseUrl, openUrl } : null}>
        <GitAccountConfigurationButton
          failure={{ code, domain, message: 'Git failed' }}
          translate={createCollaborationTranslator('zh-CN')}
          testId="configure-git"
          enabled={enabled}
          appearance={appearance}
        />
      </GitAccountConfigurationProvider>
    )
  })
}
function button() {
  return container.querySelector<HTMLButtonElement>('[data-testid="configure-git"]')
}

describe('Git account configuration action', () => {
  beforeEach(() => openUrl.mockReset())

  it('uses a quiet secondary action without an external-link icon', () => {
    render()
    const action = button()!
    expect(action.textContent).toBe('配置 Git 账户')
    expect(action.classList.contains('bg-base')).toBe(true)
    expect(action.classList.contains('text-text-secondary')).toBe(true)
    expect(action.classList.contains('bg-text-primary')).toBe(false)
    expect(action.querySelector('svg')).toBeNull()
    expect(action.classList.contains('min-h-11')).toBe(true)
    expect(action.classList.contains('md:min-h-8')).toBe(true)
  })

  it('supports a borderless regular-weight text action with responsive hit targets', async () => {
    render({ appearance: 'text' })
    const action = button()!
    expect(action.textContent).toBe('配置 Git 账户')
    expect(action.classList.contains('bg-transparent')).toBe(true)
    expect(action.classList.contains('border-0')).toBe(true)
    expect(action.classList.contains('border')).toBe(false)
    expect(action.classList.contains('bg-base')).toBe(false)
    expect(action.classList.contains('font-normal')).toBe(true)
    expect(action.classList.contains('text-text-secondary')).toBe(true)
    expect(action.classList.contains('px-0')).toBe(true)
    expect(action.classList.contains('min-h-11')).toBe(true)
    expect(action.classList.contains('min-w-11')).toBe(true)
    expect(action.classList.contains('md:min-h-6')).toBe(true)
    expect(action.querySelector('svg')).toBeNull()
    await act(async () => action.click())
    expect(openUrl).toHaveBeenCalledExactlyOnceWith(
      'https://cloud.example/wegent/settings?tab=integrations&gitDomain=git.example%3A8443#git-accounts'
    )
  })

  it.each(['credentials-required', 'authentication-failed'] as const)(
    'opens the exact domain for %s, without forwarding authentication parameters',
    async code => {
      render({ code })
      expect(button()?.textContent).toContain('配置 Git 账户')
      await act(async () => button()!.click())
      expect(openUrl).toHaveBeenCalledExactlyOnceWith(
        'https://cloud.example/wegent/settings?tab=integrations&gitDomain=git.example%3A8443#git-accounts'
      )
      expect(button()?.className).toContain('min-h-11')
    }
  )

  it.each([
    'network-error',
    'repository-inaccessible',
    'git-unavailable',
    'invalid-url',
    'clone-failed',
    'ssh-authentication-failed',
  ] as const)('does not send %s to account configuration', code => {
    render({ code })
    expect(button()).toBeNull()
    expect(openUrl).not.toHaveBeenCalled()
  })

  it('hides the action for native execution or an unavailable host', () => {
    render({ enabled: false })
    expect(button()).toBeNull()
    render({ configured: false })
    expect(button()).toBeNull()
    render({ baseUrl: 'file:///private' })
    expect(button()).toBeNull()
  })

  it('prevents duplicate navigation while opening', async () => {
    let complete!: (value: boolean) => void
    openUrl.mockReturnValue(
      new Promise(resolve => {
        complete = resolve
      })
    )
    render()
    await act(async () => button()!.click())
    expect(button()?.disabled).toBe(true)
    await act(async () => button()!.click())
    expect(openUrl).toHaveBeenCalledOnce()
    await act(async () => complete(true))
    expect(button()?.disabled).toBe(false)
  })

  it('admits only one navigation when two clicks arrive in the same render', async () => {
    render()
    await act(async () => {
      button()!.click()
      button()!.click()
    })
    expect(openUrl).toHaveBeenCalledOnce()
  })

  it.each([false, new Error('Cannot open window')])(
    'shows a retryable navigation failure',
    async result => {
      if (result instanceof Error) openUrl.mockRejectedValueOnce(result)
      else openUrl.mockResolvedValueOnce(result)
      render()
      await act(async () => button()!.click())
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        '无法打开配置页面，请重试。'
      )
      openUrl.mockResolvedValueOnce(true)
      await act(async () => button()!.click())
      expect(container.querySelector('[role="alert"]')).toBeNull()
    }
  )

  it('does not keep a previous domain navigation error on a different domain', async () => {
    openUrl.mockResolvedValueOnce(false)
    render()
    await act(async () => button()!.click())
    render({ domain: 'new.example:443' })
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })
})
