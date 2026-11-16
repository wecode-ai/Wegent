import { describe, expect, it } from 'vitest'
import type { WorkspaceAutomationRule } from '../ports/SharedWorkspaceApi'
import {
  buildScheduleCron,
  draftFromRule,
  EMPTY_DRAFT,
  scheduleLabel,
} from './automaticProcessing'

describe('statutory workday schedule drafts', () => {
  it('preserves legacy Monday–Friday semantics and defaults the filter to off', () => {
    const rule = {
      ...EMPTY_DRAFT,
      id: 'rule',
      version: 1,
      triggerType: 'schedule',
      targetName: '',
      eventType: null,
      eventConfig: {},
      timezone: 'Asia/Shanghai',
      projectId: 'project',
      executionDeviceId: null,
      nextRunAt: null,
      lastRunAt: null,
      lastRunStatus: null,
      createdAt: '',
      updatedAt: '',
    } as WorkspaceAutomationRule
    delete rule.workdayOnly
    expect(draftFromRule(rule).workdayOnly).toBe(false)
    expect(draftFromRule({ ...rule, workdayOnly: true }).workdayOnly).toBe(true)
    expect(EMPTY_DRAFT.workdayOnly).toBe(false)
    expect(scheduleLabel(rule.cronExpression!, 'zh-CN')).toBe(
      '周一至周五 09:00'
    )
    expect(scheduleLabel(rule.cronExpression!, 'en')).toBe(
      'Monday–Friday at 09:00'
    )
  })

  it.each(['0 9 * * *', '0 9 * * 1-5', '15 */3 * * *'])(
    'describes the additional filter without changing %s',
    cron => {
      expect(scheduleLabel(cron, 'zh-CN', true)).toContain(
        '仅中国大陆法定工作日'
      )
      expect(scheduleLabel(cron, 'en', true)).toContain(
        'Mainland China statutory workdays only'
      )
      expect(scheduleLabel(cron, 'en', false)).not.toContain('statutory')
    }
  )

  it('keeps daily dates unrestricted for make-up working weekends', () => {
    expect(
      buildScheduleCron({ frequency: 'daily', time: '09:00', weekday: '1' })
    ).toBe('0 9 * * *')
  })
})
