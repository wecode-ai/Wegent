import { describe, expect, it } from 'vitest'

declare global {
  interface ImportMeta {
    glob(
      pattern: string | string[],
      options: { eager: true; import: 'default'; query: '?raw' }
    ): Record<string, string>
  }
}

const sources = import.meta.glob('./useMobileRuntime.ts', {
  eager: true,
  import: 'default',
  query: '?raw',
}) as Record<string, string>

describe('mobile runtime device contract', () => {
  it('filters unsupported shells before publishing devices or loading work', () => {
    const runtime = sources['./useMobileRuntime.ts']

    expect(runtime).toContain('mobileOperableDevices(response.items)')
    expect(runtime).toContain('mobileOperableDevices(cached.devices)')
    expect(runtime).toContain('runtimeWorkForDevices(workByDeviceRef.current, operableDeviceIds)')
    expect(runtime).not.toContain('mobileRemoteDevices')
  })
})
