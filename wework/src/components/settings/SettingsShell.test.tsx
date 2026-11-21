import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { Button } from '@/components/ui/button'
import { TextField } from '@wegent/collaboration/controls/TextField'
import { SettingsShell } from './SettingsShell'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}))

function Settings() {
  const [active, setActive] = useState('general')
  return (
    <SettingsShell
      activeLabel={active}
      onBack={() => {}}
      navigation={close => (
        <nav data-testid="settings-sidebar-nav">
          {['general', 'models'].map(id => (
            <Button
              key={id}
              data-testid={'settings-nav-' + id}
              aria-current={active === id ? 'page' : undefined}
              onClick={() => {
                setActive(id)
                close()
              }}
            >
              {id}
            </Button>
          ))}
        </nav>
      )}
    >
      <TextField data-testid="settings-draft" defaultValue="Unsaved draft" />
    </SettingsShell>
  )
}

it('keeps page drafts while SDK navigation closes, restores focus and adapts back to the resizable sidebar', async () => {
  const previousWidth = window.innerWidth
  const listeners = new Set<() => void>()
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 480 })
  vi.stubGlobal('matchMedia', () => ({
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  }))
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const get = (id: string) => document.querySelector<HTMLElement>('[data-testid="' + id + '"]')
  try {
    await act(async () => root.render(<Settings />))
    expect(get('settings-sidebar-nav')).toBeNull()
    const draft = get('settings-draft')
    const trigger = get('settings-navigation-open')!
    await act(async () => {
      trigger.focus()
      trigger.click()
    })
    await vi.waitFor(() => expect(document.activeElement).toBe(get('settings-navigation-close')))
    expect(get('settings-navigation-dialog')?.getAttribute('role')).toBe('dialog')
    expect(get('settings-nav-models')).not.toBeNull()
    await act(async () =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
    )
    await vi.waitFor(() => expect(get('settings-navigation-dialog')).toBeNull())
    expect(document.activeElement).toBe(trigger)
    expect(get('settings-draft')).toBe(draft)
    expect((draft as HTMLInputElement).value).toBe('Unsaved draft')
    await act(async () => trigger.click())
    await act(async () => get('settings-nav-models')!.click())
    expect(get('settings-navigation-dialog')).toBeNull()
    expect(trigger.textContent).toContain('models')
    await act(async () => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 })
      listeners.forEach(listener => listener())
    })
    expect(get('settings-navigation-open')).toBeNull()
    expect(get('settings-sidebar-resize-handle')).not.toBeNull()
    expect(get('settings-nav-models')?.getAttribute('aria-current')).toBe('page')
    expect(get('settings-draft')).toBe(draft)
    await act(async () => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 480 })
      listeners.forEach(listener => listener())
    })
    expect(get('settings-navigation-open')?.getAttribute('aria-expanded')).toBe('false')
    expect(get('settings-navigation-dialog')).toBeNull()
  } finally {
    await act(async () => root.unmount())
    container.remove()
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: previousWidth })
    vi.unstubAllGlobals()
  }
})
