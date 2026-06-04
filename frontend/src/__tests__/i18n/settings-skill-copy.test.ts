// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import enSettings from '@/i18n/locales/en/settings.json'
import zhSettings from '@/i18n/locales/zh-CN/settings.json'

describe('settings skill copy', () => {
  it('explains both automatic and agent-bound skill usage', () => {
    expect(zhSettings.skills.libraryDescription).toBe(
      '上传、管理技能。技能可以设为自动启用，跟随你进入对话；也可以在智能体里添加技能，强化智能体的能力。'
    )
    expect(enSettings.skills.libraryDescription).toBe(
      'Upload and manage skills. Skills can be auto-enabled for your conversations or bound to agents as built-in capabilities.'
    )
  })

  it('explains that auto-enabled skills work across all conversations', () => {
    expect(zhSettings.skills.defaultEnabled.description).toBe(
      '这些技能会在你的所有对话中自动生效；也可以为模式或智能体设置例外。'
    )
    expect(enSettings.skills.defaultEnabled.description).toBe(
      'These skills automatically take effect in all your conversations. You can add exceptions for modes or agents.'
    )
  })
})
