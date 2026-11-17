// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest'
import { createCollaborationTranslator } from '../i18n'
import { executionEnvironmentErrorSummary } from './environmentConfiguration'

const translate = createCollaborationTranslator('zh-CN')
describe('execution environment failure guidance', () => {
  it('identifies a failed setup step and preserves the exit code', () => {
    expect(
      executionEnvironmentErrorSummary(
        'Failed to run project setup: Execution environment setup command 2 exited with code 7',
        false,
        translate
      )
    ).toBe('第 2 个初始化步骤失败（退出码 7）。请检查命令后重新准备项目目录。')
  })
  it('distinguishes a timeout from a command startup failure', () => {
    expect(
      executionEnvironmentErrorSummary(
        'Failed to run project setup: Execution environment setup command 1 timed out',
        false,
        translate
      )
    ).toContain('第 1 个初始化步骤超时')
    expect(
      executionEnvironmentErrorSummary(
        'Failed to run project setup: Execution environment setup command 3 could not start: missing directory',
        false,
        translate
      )
    ).toContain('检查命令和工作目录')
  })
  it('localizes the observed network error while retaining unrecognized diagnostics', () => {
    expect(executionEnvironmentErrorSummary('Failed to fetch', false, translate)).toBe(
      '无法连接服务，请检查连接后重试。'
    )
    expect(
      executionEnvironmentErrorSummary('Unrecognized executor failure', false, translate)
    ).toBe('Unrecognized executor failure')
  })
})
