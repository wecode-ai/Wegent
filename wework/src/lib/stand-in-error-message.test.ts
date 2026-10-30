import { afterEach, describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import enCommon from '@/i18n/locales/en/common.json'
import zhCommon from '@/i18n/locales/zh-CN/common.json'
import { getStandInErrorMessage } from './stand-in-error-message'

const originalLanguage = i18n.language

afterEach(async () => {
  await i18n.changeLanguage(originalLanguage)
})

describe('stand-in error localization', () => {
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

  it('localizes persisted legacy failures without an error code', async () => {
    await i18n.changeLanguage('zh-CN')
    expect(getStandInErrorMessage('Error: Stand-in role no longer exists')).toBe(
      '该分身角色已被删除，请重新选择角色。'
    )
    expect(
      getStandInErrorMessage('This assignment has already been handled or is no longer active')
    ).toBe(i18n.t('common:standIn.errors.assignment_already_handled'))
  })

  it('uses localized recovery guidance for unknown errors and preserves localized validation', async () => {
    await i18n.changeLanguage('zh-CN')
    expect(getStandInErrorMessage(new Error('internal database path'))).toBe(
      i18n.t('common:standIn.errors.failed')
    )
    expect(getStandInErrorMessage({ message: '请选择一个项目' })).toBe('请选择一个项目')
  })
})

it('preserves project-scoped agent connection guidance through repeated UI resolution', async () => {
  await i18n.changeLanguage('zh-CN')
  const error = {
    code: 'stand_in_project_connections',
    message: 'invalid task data: Project-scoped agents can only receive work from their project',
  }
  const message = getStandInErrorMessage(error)
  expect(message).toBe('该智能体只能接收所属项目的工作。请先移除其他来源连接，或改选个人智能体。')
  expect(getStandInErrorMessage(new Error(message))).toBe(message)
  expect(getStandInErrorMessage(error.message)).toBe(message)
})
