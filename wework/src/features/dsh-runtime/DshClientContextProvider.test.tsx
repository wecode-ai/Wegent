import { act, render, screen } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { applyLanguagePreference } from '@/i18n/languagePreference'
import { DshClientContextProvider } from './DshClientContextProvider'

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
  const context = {
    get: vi.fn((name: string) => (name === 'locale' ? locale : undefined)),
  } as unknown as Context
  function OfficialSlotConsumer() {
    const state = useSyncExternalStore(locale.subscribe, locale.getSnapshot)
    return <button aria-label={state.active}>{state.active}</button>
  }
  return { context, locale, OfficialSlotConsumer }
}

afterEach(async () => {
  await act(() => applyLanguagePreference('zh-CN'))
  vi.restoreAllMocks()
})

it('synchronizes mounted official slot consumers through zh to en to zh changes', async () => {
  await act(() => applyLanguagePreference('zh-CN'))
  const { context, locale, OfficialSlotConsumer } = fixture()
  const view = render(
    <DshClientContextProvider context={context}>
      <OfficialSlotConsumer />
    </DshClientContextProvider>
  )
  const button = screen.getByRole('button', { name: 'zh' })
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
  expect(first.locale.setLocale).toHaveBeenCalledExactlyOnceWith('en')
  view.rerender(
    <DshClientContextProvider context={second.context}>
      <span>Workbench</span>
    </DshClientContextProvider>
  )
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
  expect(error).toHaveBeenCalled()
  await act(() => applyLanguagePreference('en'))
  await act(() => applyLanguagePreference('zh-CN'))
  expect(locale.getSnapshot().active).toBe('zh')
})
