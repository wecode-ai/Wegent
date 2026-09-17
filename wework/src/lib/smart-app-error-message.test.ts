import { describe, expect, test } from 'vitest'
import { ApiError } from '@/api/http'
import { getSmartAppErrorMessage } from './smart-app-error-message'

const t = (_key: string, fallback?: string) => fallback ?? _key

describe('getSmartAppErrorMessage', () => {
  test('localizes known backend image errors', () => {
    expect(
      getSmartAppErrorMessage(new ApiError('Smart app image is too large', 422), '发布失败', t)
    ).toBe('图标不能超过 512 KB，单张截图不能超过 2 MB。')
  })

  test('uses validation error locations instead of the generic 422 message', () => {
    const error = new ApiError('Request parameter validation failed', 422, undefined, {
      detail: 'Request parameter validation failed',
      errors: [{ loc: ['body', 'sizeBytes'], type: 'less_than_equal' }],
    })

    expect(getSmartAppErrorMessage(error, '发布失败', t)).toContain('不要直接上传源码压缩包')
  })

  test('uses a translated parent field for nested validation locations', () => {
    const error = new ApiError('Request parameter validation failed', 422, undefined, {
      detail: 'Request parameter validation failed',
      errors: [{ loc: ['body', 'targets', 0, 'id'], type: 'missing' }],
    })

    expect(getSmartAppErrorMessage(error, '发布失败', t)).toBe('分享成员或部门无效，请重新选择。')
  })

  test('distinguishes expanded package size from archive size', () => {
    expect(
      getSmartAppErrorMessage(new Error('Smart app ZIP expands beyond 250 MB'), '发布失败', t)
    ).toBe('发布包解压后不能超过 250 MB，请精简文件后重新打包。')
  })

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
})
