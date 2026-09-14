import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { emptyPluginComponents } from '@/features/plugins/slimPluginComponents'
import type { InstalledPluginItem } from '../PluginManagementRows'
import { useInstalledPluginDetail } from './useInstalledPluginDetail'

function summary(id: string): InstalledPluginItem {
  return {
    id,
    version: '1.0.0',
    origin: 'created',
    raw: { spec: { source: { pluginKey: id }, components: emptyPluginComponents() } },
  } as InstalledPluginItem
}

test('keeps resolved connectors across background summary refreshes and clears on selection change', async () => {
  const first = summary('first')
  const components = {
    ...emptyPluginComponents(),
    connectors: [{ slug: 'site', authPolicy: 'optional' as const }],
  }
  const read = vi
    .fn()
    .mockResolvedValueOnce({ ...first.raw, spec: { ...first.raw.spec, components } })
    .mockImplementationOnce(() => new Promise(() => undefined))
  const onError = vi.fn()
  const { result, rerender } = renderHook(
    ({ plugin }) => useInstalledPluginDetail(plugin, read, onError),
    {
      initialProps: { plugin: first },
    }
  )
  await waitFor(() => expect(result.current?.raw.spec.components.connectors).toHaveLength(1))
  rerender({ plugin: summary('first') })
  expect(result.current?.raw.spec.components.connectors).toHaveLength(1)
  expect(read).toHaveBeenCalledTimes(1)
  rerender({ plugin: summary('second') })
  expect(result.current?.raw.spec.components.connectors).toHaveLength(0)
})

test('ignores a late response after switching plugins', async () => {
  let resolveFirst!: (value: unknown) => void
  const first = summary('first')
  const read = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveFirst = resolve
        })
    )
    .mockImplementationOnce(() => new Promise(() => undefined))
  const { result, rerender } = renderHook(
    ({ plugin }) => useInstalledPluginDetail(plugin, read, vi.fn()),
    {
      initialProps: { plugin: first },
    }
  )
  rerender({ plugin: summary('second') })
  await act(async () => resolveFirst(first.raw))
  expect(result.current?.id).toBe('second')
  expect(result.current?.raw.spec.components.connectors).toEqual([])
})
