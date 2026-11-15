import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import policies from './mobilePrivacyPolicy.json'

describe('bundled and publicly published privacy disclosure', () => {
  it.each(['zh', 'en'] as const)(
    'keeps the complete %s policy identical in both locations',
    language => {
      const policy = policies[language]
      const bundled = [
        `# ${policy.title}`,
        policy.updated,
        ...policy.introduction,
        ...policy.sections.flatMap(section => [`## ${section.title}`, ...section.paragraphs]),
      ].join('\n\n')
      const published = readFileSync(
        new URL(`../../../docs/${language}/wework/mobile-privacy.md`, import.meta.url),
        'utf8'
      )
        .replace(/^---\n[\s\S]*?\n---\n/, '')
        .trim()
      expect(bundled).toBe(published)
    }
  )
})
