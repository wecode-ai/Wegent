import { Context } from '@deepseek-ai/cordis'
import { act, render, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import i18n from '@/i18n'
import { DshClientContextProvider } from './DshClientContextProvider'

const initialLanguage = i18n.language

afterEach(async () => {
  await i18n.changeLanguage(initialLanguage)
})

test('keeps official component dictionaries in the Wework language across late service readiness', async () => {
  await i18n.changeLanguage('en')
  const context = new Context()
  const listeners = new Set<() => void>()
  let active = 'zh'
  const locale = {
    getSnapshot: () => ({ active }),
    setLocale: vi.fn((language: string) => {
      active = language
      listeners.forEach(listener => listener())
    }),
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const { unmount } = render(
    <DshClientContextProvider context={context}>Workbench</DshClientContextProvider>
  )
  const release = context.provide('locale', locale)
  await waitFor(() => expect(active).toBe('en'))
  expect(locale.setLocale).toHaveBeenCalledTimes(1)

  act(() => listeners.forEach(listener => listener()))
  expect(locale.setLocale).toHaveBeenCalledTimes(1)

  await act(() => i18n.changeLanguage('zh-CN'))
  expect(active).toBe('zh')
  await act(() => i18n.changeLanguage('en'))
  expect(active).toBe('en')

  act(() => {
    active = 'zh'
    listeners.forEach(listener => listener())
  })
  expect(active).toBe('en')

  unmount()
  await waitFor(() => expect(listeners.size).toBe(0))
  const writes = locale.setLocale.mock.calls.length
  await i18n.changeLanguage('zh-CN')
  expect(locale.setLocale).toHaveBeenCalledTimes(writes)
  release()
})
