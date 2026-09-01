import { describe, expect, it } from 'vitest'

declare global {
  interface ImportMeta {
    glob(
      pattern: string | string[],
      options: { eager: true; import: 'default'; query: '?raw' }
    ): Record<string, string>
  }
}

const sourceModules = import.meta.glob('./AuthorizationScreen.tsx', {
  eager: true,
  import: 'default',
  query: '?raw',
}) as Record<string, string>

const source = sourceModules['./AuthorizationScreen.tsx']

describe('authorization presentation contract', () => {
  it('presents cloud-device value before connection configuration', () => {
    expect(source).toContain('连接 Wework 云设备')
    expect(source).toContain('在手机上查看、继续和控制你的云端任务。')
    expect(source).toContain("label: '云设备'")
    expect(source).toContain("label: '会话同步'")
  })

  it('uses the transparent Wework brand asset without a synthetic icon canvas', () => {
    expect(source).toContain("require('../../assets/wework-logo-transparent.png')")
    expect(source).toContain('testID="authorization-brand-logo"')
    expect(source).not.toContain('styles.brandStatus')
  })

  it('keeps the PC cloud authorization semantics and existing automation ids', () => {
    expect(source).toContain('同步云设备、模型和会话')
    expect(source).toContain('使用 Wegent Web 安全授权，不在手机保存密码')
    expect(source).toContain('testID="backend-address"')
    expect(source).toContain('testID="authorize-login"')
  })

  it('collapses a configured service into a changeable server summary', () => {
    expect(source).toContain('configured && !configurationVisible')
    expect(source).toContain('testID="authorization-server-change"')
    expect(source).toContain('displayHost(props.backendUrl)')
  })

  it('does not expose backend implementation wording as the primary field label', () => {
    expect(source).toContain('label="Wegent 服务地址"')
    expect(source).not.toContain('label="Backend 地址"')
  })
})
