import { describe, expect, test } from 'vitest'
import { resolveDevelopmentDockIdentity } from './development-dock-identity.js'

describe('resolveDevelopmentDockIdentity', () => {
  test('uses the runtime worktree directory as the visible instance identifier', () => {
    expect(
      resolveDevelopmentDockIdentity({
        WEWORK_DEV_TITLE: 'Wgent-订阅市场',
        WEWORK_DEV_WORKTREE:
          '/Users/lys/.wework/workspace/worktrees/runtime-527542697/Wgent-订阅市场',
        WEWORK_DEV_INSTANCE_ID: 'fallback-hash',
      })
    ).toEqual({
      badge: '5275',
      displayName: 'Wgent-订阅市场 · 5275',
      instanceId: '527542697',
    })
  })

  test('supports Windows worktree paths', () => {
    expect(
      resolveDevelopmentDockIdentity({
        WEWORK_DEV_TITLE: 'feature/subscriptions',
        WEWORK_DEV_WORKTREE: String.raw`C:\Users\dev\.wework\worktrees\runtime-123456\Wegent`,
      })
    ).toEqual({
      badge: '1234',
      displayName: 'feature/subscriptions · 1234',
      instanceId: '123456',
    })
  })

  test('uses the instance label prepared by the platform launcher', () => {
    expect(
      resolveDevelopmentDockIdentity({
        WEWORK_DEV_DOCK_TITLE: '实现订阅市场 · 9876',
        WEWORK_DEV_TITLE: '实现订阅市场',
        WEWORK_DEV_INSTANCE_LABEL: '987654321',
        WEWORK_DEV_WORKTREE: '/Users/dev/github/Wegent',
      })
    ).toEqual({
      badge: '9876',
      displayName: '实现订阅市场 · 9876',
      instanceId: '987654321',
    })
  })

  test('falls back to the stable worktree hash outside a managed runtime directory', () => {
    expect(
      resolveDevelopmentDockIdentity({
        WEWORK_DEV_TITLE: 'local-checkout',
        WEWORK_DEV_WORKTREE: '/Users/dev/github/Wegent',
        WEWORK_DEV_INSTANCE_ID: 'a1b2c3d4e5f6',
      })
    ).toEqual({
      badge: 'a1b2',
      displayName: 'local-checkout · a1b2',
      instanceId: 'a1b2c3d4e5f6',
    })
  })

  test('ignores blank configured instance values', () => {
    expect(
      resolveDevelopmentDockIdentity({
        WEWORK_DEV_INSTANCE_ID: 'a1b2c3d4e5f6',
        WEWORK_DEV_INSTANCE_LABEL: ' ',
        WEWORK_DEV_TITLE: 'local-checkout',
      })
    ).toEqual({
      badge: 'a1b2',
      displayName: 'local-checkout · a1b2',
      instanceId: 'a1b2c3d4e5f6',
    })
  })

  test('does not configure release or unidentified development instances', () => {
    expect(resolveDevelopmentDockIdentity({})).toBeNull()
    expect(resolveDevelopmentDockIdentity({ WEWORK_DEV_TITLE: 'local-checkout' })).toBeNull()
  })
})
