import { createInstance } from 'i18next'
import { localizeExecutionResult } from '@/features/knowledge/code-wiki/localizeExecutionResult'
import en from '@/i18n/locales/en/knowledge.json'
import zh from '@/i18n/locales/zh-CN/knowledge.json'

describe.each([
  ['en', en],
  ['zh-CN', zh],
] as const)('scheduled result localization (%s)', (language, locale) => {
  it('translates all known results using the knowledge namespace from either entry', async () => {
    const i18n = createInstance()
    await i18n.init({ lng: language, resources: { [language]: { knowledge: locale } } })
    const messages = {
      'repository unchanged since last run': 'repositoryUnchanged',
      'Skipped because scheduled update was deleted': 'deleted',
      'Skipped because scheduled update was disabled': 'disabled',
      'Skipped because another generation is running': 'generationRunning',
      'Code Wiki no longer exists or its reference no longer matches': 'wikiUnavailable',
    } as const
    for (const namespace of ['feed', 'knowledge']) {
      const t = i18n.getFixedT(language, namespace)
      for (const [message, key] of Object.entries(messages)) {
        expect(localizeExecutionResult(message, t)).toBe(
          locale.codeWiki.scheduledUpdate.results[key]
        )
      }
      for (const mode of ['full', 'incremental'] as const) {
        expect(localizeExecutionResult(`${mode} generation started`, t)).toBe(
          locale.codeWiki.scheduledUpdate.results.generationStarted.replace(
            '{{mode}}',
            locale.codeWiki.history.mode[mode]
          )
        )
      }
      expect(localizeExecutionResult('arbitrary diagnostic', t)).toBe('arbitrary diagnostic')
    }
  })
})
