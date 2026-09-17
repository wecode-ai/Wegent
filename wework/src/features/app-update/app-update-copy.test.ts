import { describe, expect, test } from 'vitest'
import i18n from '@/i18n'
import type { AppUpdateContextValue } from './app-update-context'
import { getAppUpdateCopy } from './app-update-copy'
import type { WeworkUpdateInfo } from '@/lib/app-updater'

const state: AppUpdateContextValue = {
  currentVersion: '0.5.0-beta.1',
  updateChannel: 'stable',
  autoUpdateEnabled: true,
  availableUpdate: null,
  isUpdateReady: false,
  installedReleaseNotes: null,
  status: 'available',
  downloadProgress: null,
  error: null,
  checkNow: async () => null,
  installUpdate: async () => undefined,
  dismissInstalledReleaseNotes: () => undefined,
  setAutoUpdateEnabled: () => undefined,
  setUpdateChannel: async () => undefined,
}

function copy(overrides: Partial<AppUpdateContextValue> = {}, language = 'zh-CN') {
  return getAppUpdateCopy({ ...state, ...overrides }, i18n.getFixedT(language, 'common'))
}

const update: WeworkUpdateInfo = {
  currentVersion: '0.5.0-beta.1',
  version: '0.4.3',
  kind: 'downgrade-to-stable',
}

describe('app update copy', () => {
  test.each([
    ['upgrade-stable', '升级到正式版 0.4.3', '发现新正式版 0.4.3'],
    ['upgrade-beta', '升级到测试版 0.4.3', '发现新测试版 0.4.3'],
    ['return-to-stable', '回到正式版 0.4.3', '可回到正式版 0.4.3'],
    ['downgrade-to-stable', '回到正式版 0.4.3', '可回到正式版 0.4.3，版本号低于当前版本'],
  ] as const)('describes %s explicitly', (kind, action, message) => {
    expect(copy({ availableUpdate: { ...update, kind } })).toEqual({ action, message })
  })

  test('offers restart only after the selected release is downloaded', () => {
    expect(copy({ availableUpdate: update, isUpdateReady: true })).toEqual({
      action: '重启并回到正式版',
      message: '正式版 0.4.3 已就绪，重启后完成版本切换',
    })
    expect(
      copy({ availableUpdate: { ...update, kind: 'upgrade-stable' }, isUpdateReady: true }).action
    ).toBe('重启并升级')
  })

  test('distinguishes no stable release from no newer version', () => {
    expect(copy({ status: 'upToDate' }).message).toBe('暂无可用正式版')
    expect(copy({ status: 'upToDate', updateChannel: 'beta' }).message).toBe('暂无可用更新')
    expect(copy({ status: 'upToDate', currentVersion: '0.5.0' }).message).toBe('暂无可用更新')
  })

  test('shows progress instead of an available release during a transfer', () => {
    const result = copy({
      status: 'downloading',
      availableUpdate: update,
      downloadProgress: { downloadedBytes: 1, totalBytes: null },
    })
    expect(result.action).toBe('下载中…')
    expect(result.message).toBe('正在下载更新')
    expect(result.message).not.toContain('%')
    expect(copy({ status: 'checking', availableUpdate: update }).message).toBe('正在检查更新…')
  })

  test.each([
    ['check', '重新检查'],
    ['download', '重试下载'],
    ['install', '重试安装'],
  ] as const)('offers the correct recovery action for %s', (stage, action) => {
    const result = copy({
      status: 'error',
      availableUpdate: update,
      error: { stage, kind: 'generic', code: 'TEST', occurredAt: 0, detail: null },
    })
    expect(result.action).toBe(action)
    expect(result.message).not.toContain('暂无')
  })

  test('offers a fresh download after verification fails', () => {
    const result = copy({
      status: 'error',
      availableUpdate: update,
      error: {
        stage: 'download',
        kind: 'verification',
        code: 'APP_UPDATE_VERIFICATION_FAILED',
        occurredAt: 0,
        detail: null,
      },
    })
    expect(result).toEqual({ action: '重新下载', message: '更新文件校验失败，请重新下载' })
  })

  test('has English rollback copy', () => {
    expect(copy({ availableUpdate: update }, 'en')).toEqual({
      action: 'Return to stable 0.4.3',
      message: 'You can return to stable 0.4.3, which is older than your current version',
    })
  })
})
