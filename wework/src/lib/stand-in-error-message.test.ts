// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import enCommon from '@/i18n/locales/en/common.json'
import zhCommon from '@/i18n/locales/zh-CN/common.json'
import {
  getStandInErrorMessage,
  reportStandInError,
  requiresStandInUpgrade,
} from './stand-in-error-message'

const originalLanguage = i18n.language

afterEach(async () => {
  await i18n.changeLanguage(originalLanguage)
})

describe('stand-in error localization', () => {
  it.each(['zh-CN', 'en'])(
    'offers reasoning recovery for structured and persisted failures in %s',
    async language => {
      await i18n.changeLanguage(language)
      const expected = i18n.t('common:standIn.errors.model_reasoning_unavailable')
      expect(getStandInErrorMessage({ code: 'model_reasoning_unavailable' })).toBe(expected)
      expect(
        getStandInErrorMessage(
          new Error(
            'The selected model does not support the saved reasoning effort; update the stand-in model settings'
          )
        )
      ).toBe(expected)
      expect(expected).not.toBe(i18n.t('common:standIn.errors.model_unavailable'))
    }
  )
  it('keeps compatibility guidance independent of the failed operation in both languages', async () => {
    for (const [language, message] of [
      ['zh-CN', '当前 Wework 与执行设备的版本不兼容。请前往云端工作查看设备情况，升级后重试。'],
      [
        'en',
        'Wework and the execution device use incompatible versions. Open Cloud work to check device status, upgrade, and try again.',
      ],
    ]) {
      await i18n.changeLanguage(language)
      for (const fallback of ['load_settings_failed', 'save_settings_failed'] as const) {
        expect(getStandInErrorMessage({ code: 'unsupported_method' }, fallback)).toBe(message)
      }
    }
  })

  it.each(['protocol_mismatch', 'unsupported_method', 'executor_update_required'])(
    'offers upgrade recovery for structured compatibility error %s',
    code => {
      expect(requiresStandInUpgrade({ code })).toBe(true)
    }
  )
  it.each([
    null,
    undefined,
    { code: 'device_offline' },
    { status: 503 },
    new Error('unsupported_method'),
    '当前 Wework 与执行设备的版本不兼容',
  ])('does not infer upgrade recovery from unrelated errors or display text: %j', error => {
    expect(requiresStandInUpgrade(error)).toBe(false)
  })
  it('records the failing operation and transport code without logging error contents', () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      reportStandInError(
        'load_environment',
        {
          code: 'executor_disconnected',
          status: 503,
          message: 'private request contents',
          token: 'secret-token',
        },
        'device'
      )
      expect(log).toHaveBeenCalledOnce()
      expect(log.mock.calls[0][0]).toBe('[Wework] Runtime task create diagnostic')
      expect(JSON.parse(log.mock.calls[0][1])).toEqual(
        expect.objectContaining({
          stage: 'stand-in-operation-failed',
          operation: 'load_environment',
          deviceId: 'device',
          code: 'executor_disconnected',
          status: 503,
        })
      )
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/private request contents|secret-token/)
    } finally {
      log.mockRestore()
    }
  })
  it('distinguishes device transport and service failures without exposing raw internals', async () => {
    await i18n.changeLanguage('zh-CN')
    for (const [error, key] of [
      [{ code: 'executor_disconnected' }, 'executor_unavailable'],
      [new Error('local-sidebar-runtime-changed'), 'executor_restarted'],
      [{ code: 'protocol_mismatch' }, 'executor_update_required'],
      [{ code: 'unsupported_method' }, 'executor_update_required'],
      [{ status: 401 }, 'authentication_required'],
      [{ code: 'http_503' }, 'service_unavailable'],
      [{ status: 403 }, 'permission_denied'],
      [new Error('executor-not-found:device'), 'executor_unavailable'],
      [new Error('executor-offline:device'), 'device_offline'],
      [new Error('ambiguous-executor-identity:device'), 'executor_ambiguous'],
    ] as const) {
      expect(getStandInErrorMessage(error)).toBe(i18n.t(`common:standIn.errors.${key}`))
    }
  })

  it('identifies the failed operation even after an inner boundary localized an unknown error', async () => {
    for (const language of ['zh-CN', 'en']) {
      await i18n.changeLanguage(language)
      const error = getStandInErrorMessage(new Error('internal database path'))
      for (const operation of [
        'load_settings_failed',
        'save_settings_failed',
        'load_environment_failed',
        'load_projects_failed',
      ] as const) {
        expect(getStandInErrorMessage(error, operation)).toBe(
          i18n.t(`common:standIn.errors.${operation}`)
        )
      }
      expect(getStandInErrorMessage({ code: 'permission_denied' }, 'load_environment_failed')).toBe(
        i18n.t('common:standIn.errors.permission_denied')
      )
    }
  })
  it('provides recovery guidance for every registered error in both languages', async () => {
    expect(Object.keys(enCommon.standIn.errors).sort()).toEqual(
      Object.keys(zhCommon.standIn.errors).sort()
    )
    for (const language of ['en', 'zh-CN']) {
      await i18n.changeLanguage(language)
      const messages = language === 'en' ? enCommon.standIn.errors : zhCommon.standIn.errors
      for (const [code, message] of Object.entries(messages)) {
        expect(getStandInErrorMessage({ code, message: 'internal error' })).toBe(message)
      }
    }
  })
  it('localizes the reported assignment error in both languages', async () => {
    const error = Object.assign(
      new Error('This assignment has already been handled or is no longer active'),
      {
        code: 'assignment_already_handled',
      }
    )
    await i18n.changeLanguage('zh-CN')
    expect(getStandInErrorMessage(error)).toBe('本次分配已处理或已失效，请刷新任务并查看最新分配。')
    await i18n.changeLanguage('en')
    expect(getStandInErrorMessage(error)).toBe(
      i18n.t('common:standIn.errors.assignment_already_handled')
    )
  })

  it('explains how to recover a persisted missing source dependency in both languages', async () => {
    const error = { code: 'dependency_missing', message: 'Dependency dingtalk is missing' }
    await i18n.changeLanguage('zh-CN')
    const chinese =
      '来源所需插件尚未安装。请打开助理设置，在「连接」中选择该来源并点击「安装所需插件」，安装后重新加载。'
    expect(getStandInErrorMessage(error)).toBe(chinese)
    expect(getStandInErrorMessage(new Error(chinese))).toBe(chinese)
    await i18n.changeLanguage('en')
    const english =
      'A required source plugin is not installed. Open Stand-in settings, select the source under Connections, and choose Install required plugins. Then reload the source.'
    expect(getStandInErrorMessage(error)).toBe(english)
    expect(getStandInErrorMessage(new Error(english))).toBe(english)
  })
})

it('preserves recovery guidance for historical agent binding errors through repeated UI resolution', async () => {
  await i18n.changeLanguage('zh-CN')
  const error = {
    code: 'stand_in_project_connections',
    message: 'invalid task data: Project-scoped agents can only receive work from their project',
  }
  const message = getStandInErrorMessage(error)
  expect(message).toBe('助理的旧智能体绑定已失效。请重新加载助理设置后重试。')
  expect(getStandInErrorMessage(new Error(message))).toBe(message)
  expect(getStandInErrorMessage(error.message)).toBe(message)
})

it('maps a submitted interface needing restoration to model selection guidance', async () => {
  for (const language of ['zh-CN', 'en']) {
    await i18n.changeLanguage(language)
    const message = "Reselect the task's submitted model interface to restore its credentials"
    const expected = i18n.t('common:standIn.errors.model_unavailable')
    expect(getStandInErrorMessage({ code: 'RUNNER_MODEL_UNAVAILABLE', message })).toBe(expected)
    expect(getStandInErrorMessage(new Error(message))).toBe(expected)
  }
})
