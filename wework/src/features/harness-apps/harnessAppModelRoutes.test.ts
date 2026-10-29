import { describe, expect, test, vi } from 'vitest'
import { registerAdditionalHarnessAppModels } from './harnessAppModelRoutes'
import type { LocalHarnessModelOption } from '@/features/local-harness/localHarnessModels'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'

const option = (key: string): LocalHarnessModelOption =>
  ({ key, label: key }) as LocalHarnessModelOption

describe('registerAdditionalHarnessAppModels', () => {
  test('registers all additional routes concurrently while preserving model order', async () => {
    const resolvers = new Map<string, (value: { baseUrl: string; proxyToken: string }) => void>()
    const resolveLaunch = vi.fn(
      (_harnessId, model: LocalHarnessModelOption) =>
        new Promise<{ baseUrl: string; proxyToken: string }>(resolve => {
          resolvers.set(model.key, resolve)
        })
    )
    const tokens: string[] = []

    const result = registerAdditionalHarnessAppModels(
      option('default'),
      [option('default'), option('second'), option('third')],
      { resolveLaunch } as unknown as NonNullable<WorkbenchServices['localHarnessModelApi']>,
      token => tokens.push(token)
    )

    expect(resolveLaunch).toHaveBeenCalledTimes(2)
    resolvers.get('third')?.({ baseUrl: 'http://127.0.0.1/third', proxyToken: 'third-token' })
    resolvers.get('second')?.({ baseUrl: 'http://127.0.0.1/second', proxyToken: 'second-token' })
    expect(await result).toEqual([
      { modelKey: 'second', displayName: 'second', baseUrl: 'http://127.0.0.1/second' },
      { modelKey: 'third', displayName: 'third', baseUrl: 'http://127.0.0.1/third' },
    ])
    expect(tokens).toEqual(['second-token', 'third-token'])
  })
})
