import { describe, expect, it } from 'vitest'
import { createCollaborationTranslator } from '../i18n'
import { providerTerminology } from './providerTerminology'

describe('source-owned record terminology', () => {
  it.each(['zh-CN', 'en'] as const)('keeps source names and locale in %s', locale => {
    const translate = createCollaborationTranslator(locale)
    for (const [provider, kind] of [
      ['github', 'GitHub Issue'],
      ['gitlab', 'GitLab Issue'],
      ['dingtalk_aitable', locale === 'en' ? 'table record' : '表格记录'],
    ]) {
      const scoped = providerTerminology(provider, translate)
      expect(scoped('todo.new_issue')).toContain(kind)
      expect(scoped('todo.parent_issue')).toContain(kind)
      expect(scoped('todo.create_issue_failed')).toContain(kind)
      expect(scoped.locale).toBe(translate.locale)
      expect(scoped('todo.thread_goals')).toBe(translate('todo.thread_goals'))
    }
    expect(providerTerminology('local', translate)).toBe(translate)
  })
})
