import { describe, expect, test } from 'vitest'
import {
  DEFAULT_RUNTIME_PERMISSION_MODE,
  runtimePermissionMode,
  runtimePermissionProfile,
} from './runtimePermissionMode'
import { normalizeModelOptions } from '@/lib/model-ui'
import type { UnifiedModel } from '@/types/api'

describe('runtimePermissionMode', () => {
  test('uses workspace access by default', () => {
    expect(runtimePermissionMode()).toBe(DEFAULT_RUNTIME_PERMISSION_MODE)
    expect(runtimePermissionProfile(runtimePermissionMode())).toBe(':workspace')
  })

  test('maps supported modes to Codex permission profiles', () => {
    expect(runtimePermissionProfile(runtimePermissionMode({ permissionMode: 'read-only' }))).toBe(
      ':read-only'
    )
    expect(runtimePermissionProfile(runtimePermissionMode({ permissionMode: 'full-access' }))).toBe(
      ':danger-full-access'
    )
  })

  test('ignores an unknown persisted value', () => {
    expect(runtimePermissionMode({ permissionMode: 'unknown' })).toBe('workspace-write')
  })

  test('survives model option normalization and session restoration', () => {
    const model: UnifiedModel = {
      name: 'gpt-test',
      type: 'runtime',
      config: {
        ui: {
          family: 'gpt',
        },
      },
    }

    expect(normalizeModelOptions(model, { permissionMode: 'full-access' })).toMatchObject({
      permissionMode: 'full-access',
    })
  })
})
