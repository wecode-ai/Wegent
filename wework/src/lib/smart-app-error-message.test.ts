// @vitest-environment node

import { DesktopHostError } from '@/api/dsh/desktopHost'
import { describe, expect, test } from 'vitest'
import {
  getSmartAppErrorMessage,
  isOutdatedSmartAppCreationHost,
  isSmartAppSaveLocationError,
} from './smart-app-error-message'

const t = (_key: string, fallback?: string) => fallback ?? _key

describe('getSmartAppErrorMessage', () => {
  test('does not leak unknown Smart App host errors into the Chinese UI', () => {
    expect(
      getSmartAppErrorMessage(
        new Error('Smart app internal implementation detail'),
        '智能工作台操作失败',
        t
      )
    ).toBe('智能工作台操作失败')
  })

  test('does not leak an unrelated English transport error into the Chinese UI', () => {
    expect(getSmartAppErrorMessage(new Error('Failed to fetch'), '智能工作台发布失败', t)).toBe(
      '智能工作台发布失败'
    )
  })

  test('localizes save location permission errors and marks them as recoverable', () => {
    const error = new Error('EACCES: permission denied, mkdir C:\\Users\\me\\Documents')

    expect(getSmartAppErrorMessage(error, '创建失败', t)).toBe(
      '无法在该位置创建工作台，请选择有写入权限的目录。'
    )
    expect(isSmartAppSaveLocationError(error)).toBe(true)
    expect(isSmartAppSaveLocationError(new Error('Smart app template is invalid'))).toBe(false)
  })

  test('recognizes an old desktop host rejecting fields that are now optional', () => {
    const emptyInput = { parentPath: '', description: '' }
    expect(
      isOutdatedSmartAppCreationHost(
        new DesktopHostError('invalid_params', 'parentPath is required'),
        emptyInput
      )
    ).toBe(true)
    expect(
      isOutdatedSmartAppCreationHost(
        new DesktopHostError('invalid_params', 'description is required'),
        emptyInput
      )
    ).toBe(true)
    expect(
      isOutdatedSmartAppCreationHost(
        new DesktopHostError('invalid_params', 'parentPath is required'),
        { parentPath: '/chosen', description: '' }
      )
    ).toBe(false)
    expect(
      isOutdatedSmartAppCreationHost(
        new DesktopHostError('capability_failed', 'parentPath is required'),
        emptyInput
      )
    ).toBe(false)
  })
})
