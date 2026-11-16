import { describe, expect, test } from 'vitest'
import {
  composerSkillFilePath,
  createComposerMentionElement,
  findComposerMentionDeletionRange,
  parseComposerMentions,
  replaceComposerMentionTrigger,
} from './composerMentions'

const GMAIL_REFERENCE = '[$gmail](/tmp/gmail/SKILL.md)'

test('recovers after long malformed references without rescanning their prefixes', () => {
  const malformed = '['.repeat(100_000)
  const reference = '[$test](~/test/SKILL.md)'
  for (const prefix of [malformed, `${malformed}](unterminated`, '[]()', '[bad] text']) {
    const input = `${prefix}\n${reference}`
    expect(parseComposerMentions(input)).toEqual([
      expect.objectContaining({ reference, start: prefix.length + 1, end: input.length }),
    ])
  }
})

describe('composerSkillFilePath', () => {
  test.each(['https://example.com/SKILL.md'])('keeps HTTP links as ordinary links: %s', path => {
    const reference = `[$test-skill](${path})`
    expect(composerSkillFilePath(reference)).toBeNull()
    expect(parseComposerMentions(reference)).toEqual([])
  })
})

describe('findComposerMentionDeletionRange', () => {
  test('deletes a mention as one unit from its right boundary', () => {
    expect(
      findComposerMentionDeletionRange(
        GMAIL_REFERENCE,
        GMAIL_REFERENCE.length,
        GMAIL_REFERENCE.length,
        'Backspace'
      )
    ).toEqual({ start: 0, end: GMAIL_REFERENCE.length, cursor: 0 })
  })

  test('deletes the complete mention selection without leaving a line break', () => {
    const value = `${GMAIL_REFERENCE} `
    const range = findComposerMentionDeletionRange(value, 0, value.length, 'Backspace')

    expect(range).toEqual({ start: 0, end: value.length, cursor: 0 })
    expect(value.slice(0, range?.start) + value.slice(range?.end)).toBe('')
  })

  test('deletes a mention as one unit from its left boundary', () => {
    expect(findComposerMentionDeletionRange(GMAIL_REFERENCE, 0, 0, 'Delete')).toEqual({
      start: 0,
      end: GMAIL_REFERENCE.length,
      cursor: 0,
    })
  })
})

describe('replaceComposerMentionTrigger', () => {
  test('places the caret after the separator space used by the atomic mention', () => {
    const result = replaceComposerMentionTrigger('$gmail', GMAIL_REFERENCE, 0, 6)

    expect(result).toEqual({
      value: `${GMAIL_REFERENCE} `,
      cursor: GMAIL_REFERENCE.length + 1,
    })
  })
})

describe('cloud references', () => {
  test.each(['agent'])('preserves %s references alongside skill references', kind => {
    const label = kind === 'issue' ? '#42 Test issue' : '@Test reference'
    const reference = `[$${label}](wework-${kind}://test-project/test-id)`
    const [mention] = parseComposerMentions(reference)
    expect(mention).toMatchObject({ name: label, label, reference })
    expect(composerSkillFilePath(reference)).toBeNull()
    const element = createComposerMentionElement(mention)
    expect(element).toHaveAttribute('data-composer-reference-kind', kind)
    expect(element.textContent).toBe(label.slice(1))
  })
})
