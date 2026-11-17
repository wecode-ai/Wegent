import { useSyncExternalStore } from 'react'
import { applyLanguagePreference } from '@/i18n/languagePreference'
import { Context } from '@deepseek-ai/cordis'
import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, it, vi } from 'vitest'
import i18n from '@/i18n'
import { DshClientContextProvider } from './DshClientContextProvider'

const initialLanguage = i18n.language

afterEach(async () => {
  await i18n.changeLanguage(initialLanguage)
  vi.restoreAllMocks()
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

function fixture(active = 'en') {
  let snapshot = { active }
  const listeners = new Set<() => void>()
  const locale = {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setLocale: vi.fn((active: string) => {
      snapshot = { active }
      for (const listener of listeners) listener()
    }),
  }
  const context = new Context()
  context.provide('locale', locale)
  function OfficialSlotConsumer() {
    const state = useSyncExternalStore(locale.subscribe, locale.getSnapshot)
    return <button aria-label={state.active}>{state.active}</button>
  }
  return { context, locale, OfficialSlotConsumer }
}

it('synchronizes mounted official slot consumers through zh to en to zh changes', async () => {
  await act(() => applyLanguagePreference('zh-CN'))
  const { context, locale, OfficialSlotConsumer } = fixture()
  const view = render(
    <DshClientContextProvider context={context}>
      <OfficialSlotConsumer />
    </DshClientContextProvider>
  )
  const button = await screen.findByRole('button', { name: 'zh' })
  await act(() => applyLanguagePreference('en'))
  expect(screen.getByRole('button', { name: 'en' })).toBe(button)
  await act(() => applyLanguagePreference('zh-CN'))
  expect(screen.getByRole('button', { name: 'zh' })).toBe(button)
  expect(locale.setLocale.mock.calls.map(([language]) => language)).toEqual(['zh', 'en', 'zh'])
  view.unmount()
  await act(() => applyLanguagePreference('en'))
  expect(locale.setLocale).toHaveBeenCalledTimes(3)
})

it('adopts the current host language on mount and replaces the subscription with its context', async () => {
  await act(() => applyLanguagePreference('en'))
  const first = fixture('zh')
  const second = fixture('zh')
  const view = render(
    <DshClientContextProvider context={first.context}>
      <span>Workbench</span>
    </DshClientContextProvider>
  )
  await waitFor(() => expect(first.locale.setLocale).toHaveBeenCalledExactlyOnceWith('en'))
  view.rerender(
    <DshClientContextProvider context={second.context}>
      <span>Workbench</span>
    </DshClientContextProvider>
  )
  await waitFor(() => expect(second.locale.setLocale).toHaveBeenCalledExactlyOnceWith('en'))
  await act(() => applyLanguagePreference('zh-CN'))
  expect(first.locale.setLocale).toHaveBeenCalledTimes(1)
  expect(second.locale.setLocale.mock.calls.map(([language]) => language)).toEqual(['en', 'zh'])
})

it('keeps the workbench mounted when locale synchronization fails and recovers on a later change', async () => {
  await act(() => applyLanguagePreference('zh-CN'))
  const { context, locale } = fixture()
  locale.setLocale.mockImplementationOnce(() => {
    throw new Error('Locale write unavailable')
  })
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  render(
    <DshClientContextProvider context={context}>
      <span>Workbench</span>
    </DshClientContextProvider>
  )
  expect(screen.getByText('Workbench')).toBeVisible()
  await waitFor(() => expect(error).toHaveBeenCalled())
  await act(() => applyLanguagePreference('en'))
  await act(() => applyLanguagePreference('zh-CN'))
  expect(locale.getSnapshot().active).toBe('zh')
})
