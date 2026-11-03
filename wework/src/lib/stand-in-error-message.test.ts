import i18n from '@/i18n'
import { afterEach, describe, expect, it } from 'vitest'
import { getStandInErrorMessage } from './stand-in-error-message'

const originalLanguage = i18n.language

afterEach(async () => {
  await i18n.changeLanguage(originalLanguage)
})

describe('stand-in error localization', () => {
  it('explains how to recover a persisted missing source dependency in both languages', async () => {
    const error = { code: 'dependency_missing', message: 'Dependency dingtalk is missing' }
    await i18n.changeLanguage('zh-CN')
    const chinese =
      '来源所需插件尚未安装。请打开分身设置，在「连接」中选择该来源并点击「安装所需插件」，安装后重新加载。'
    expect(getStandInErrorMessage(error)).toBe(chinese)
    expect(getStandInErrorMessage(new Error(chinese))).toBe(chinese)
    await i18n.changeLanguage('en')
    const english =
      'A required source plugin is not installed. Open Stand-in settings, select the source under Connections, and choose Install required plugins. Then reload the source.'
    expect(getStandInErrorMessage(error)).toBe(english)
    expect(getStandInErrorMessage(new Error(english))).toBe(english)
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
