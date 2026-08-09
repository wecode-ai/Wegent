import { describe, expect, test } from 'vitest'
import {
  composerSkillFilePath,
  createComposerMentionElement,
  findComposerMentionDeletionRange,
  parseComposerMentions,
  registerComposerMentionIcon,
  replaceComposerMentionTrigger,
} from './composerMentions'

const GMAIL_REFERENCE = '[$gmail](/tmp/gmail/SKILL.md)'

describe('composerSkillFilePath', () => {
  test('reads direct skill file paths without a URI prefix', () => {
    expect(composerSkillFilePath(GMAIL_REFERENCE)).toBe('/tmp/gmail/SKILL.md')
  })

  test('continues to read stored legacy skill references', () => {
    expect(composerSkillFilePath('[$gmail](skill:///tmp/gmail/SKILL.md)')).toBe(
      '/tmp/gmail/SKILL.md'
    )
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

  test('allows the separator space to be deleted before the mention', () => {
    const value = `${GMAIL_REFERENCE} `

    expect(
      findComposerMentionDeletionRange(value, value.length, value.length, 'Backspace')
    ).toBeNull()
  })

  test('deletes the complete mention selection without leaving a line break', () => {
    const value = `${GMAIL_REFERENCE} `
    const range = findComposerMentionDeletionRange(value, 0, value.length, 'Backspace')

    expect(range).toEqual({ start: 0, end: value.length, cursor: 0 })
    expect(value.slice(0, range?.start) + value.slice(range?.end)).toBe('')
  })

  test('does not delete a mention when backspacing ordinary text after it', () => {
    const value = `${GMAIL_REFERENCE}a`

    expect(
      findComposerMentionDeletionRange(value, value.length, value.length, 'Backspace')
    ).toBeNull()
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
  test('keeps cloud references atomic in the composer', () => {
    const reference = '[$design.md](cloud://projects/11/files/42)'

    expect(parseComposerMentions(reference)).toEqual([
      expect.objectContaining({ name: 'design.md', reference, start: 0, end: reference.length }),
    ])
    expect(
      findComposerMentionDeletionRange(reference, reference.length, reference.length, 'Backspace')
    ).toEqual({ start: 0, end: reference.length, cursor: 0 })
  })
})

describe('composer mention icons', () => {
  test('uses a registered plugin brand icon', () => {
    const reference = '[$GitHub](plugin://github@openai-bundled)'
    registerComposerMentionIcon(reference, 'https://example.com/github.png')

    const element = createComposerMentionElement({
      name: 'GitHub',
      label: 'GitHub',
      reference,
    })

    expect(element.querySelector('img')).toHaveAttribute('src', 'https://example.com/github.png')
  })

  test('uses the plugin initial when no brand logo exists', () => {
    const reference = '[$superpowers](plugin://superpowers@openai-official)'
    const element = createComposerMentionElement({
      name: 'superpowers',
      label: 'Superpowers',
      reference,
    })

    expect(element.querySelector('img')).toBeNull()
    expect(element.querySelector('.composer-mention-initial-icon')).toHaveTextContent('S')
    expect(element.querySelector('svg.composer-mention-icon')).toBeNull()
  })

  test('keeps the generic cube icon for skill mentions without a brand logo', () => {
    const reference = '[$gmail](/tmp/gmail/SKILL.md)'
    const element = createComposerMentionElement({
      name: 'gmail',
      label: 'Gmail',
      reference,
    })

    expect(element.querySelector('img')).toBeNull()
    expect(element.querySelector('svg.composer-mention-icon')).not.toBeNull()
  })
})
