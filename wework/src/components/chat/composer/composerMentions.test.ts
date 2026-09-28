import { afterEach, describe, expect, test } from 'vitest'
import { createConversationMentionReference } from '@/lib/conversation-mentions'
import {
  composerSkillFilePath,
  composerPathReference,
  classifyComposerReference,
  createComposerMentionElement,
  findComposerMentionDeletionRange,
  parseComposerMentions,
  registerComposerMentionIcon,
  replaceComposerMentionTrigger,
} from './composerMentions'
import { publishComposerApps, resetComposerAppsMemory } from './composerAppsSnapshot'
import references from '../../../../../packages/chat-core/test-fixtures/prompt-mentions.json'
import { createComposerDocument, serializeComposerDocument } from './composerProseMirrorModel'

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

test('uses distinct file-type icons and preserves a requested skill icon', () => {
  const icon = (reference: string) =>
    createComposerMentionElement(parseComposerMentions(reference)[0]).querySelector('svg')!
      .innerHTML
  const file = icon('[test](~/test-document.md)')
  const code = icon('[test](C:/test-file.ts)')
  const skill = icon('[$test](~/test-skill/SKILL.md)')
  const pencil = icon('[$test?icon=pencil-sparkle](~/test-skill/SKILL.md)')
  expect(new Set([file, code, skill, pencil]).size).toBe(4)
})

test('recognizes a reference whose label ends in a backslash before its closing bracket', () => {
  const reference = '[test\\](~/test-skill/SKILL.md)'
  expect(parseComposerMentions(reference)[0]?.reference).toBe(reference)
})

describe('composerSkillFilePath', () => {
  test.each(references)('classifies and preserves $reference', fixture => {
    const label = fixture.reference.slice(1, fixture.reference.indexOf(']('))
    expect(classifyComposerReference(label, fixture.href)).toBe(fixture.kind)
    const mentions = parseComposerMentions(fixture.reference)
    if (fixture.kind === null && !fixture.composerKind) {
      expect(mentions).toEqual([])
    } else {
      expect(mentions).toHaveLength(1)
      expect(mentions[0]).toMatchObject({ name: fixture.name, reference: fixture.reference })
    }
    expect(composerSkillFilePath(fixture.reference)).toBe(
      fixture.kind === 'skill' ? fixture.href : null
    )
    if (fixture.composerKind === 'file') {
      expect(composerPathReference(fixture.reference)).toEqual({
        path: fixture.href,
        directory: false,
      })
    }
    expect(serializeComposerDocument(createComposerDocument(fixture.reference))).toBe(
      fixture.reference
    )
  })
  test('recognizes home-relative skills and preserves their reference', () => {
    const reference = '[$test-skill](~/.agents/skills/test-skill/SKILL.md)'
    expect(composerSkillFilePath(reference)).toBe('~/.agents/skills/test-skill/SKILL.md')
    expect(parseComposerMentions(reference)).toEqual([
      { name: 'test-skill', label: 'Test Skill', reference, start: 0, end: reference.length },
    ])
  })

  test.each(['https://example.com/SKILL.md', 'http://example.com/skills', 'HTTPS://example.com'])(
    'keeps HTTP links as ordinary links: %s',
    path => {
      const reference = `[$test-skill](${path})`
      expect(composerSkillFilePath(reference)).toBeNull()
      expect(parseComposerMentions(reference)).toEqual([])
    }
  )

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
  test.each(['member', 'agent', 'group', 'issue'])(
    'preserves %s references alongside skill references',
    kind => {
      const label = kind === 'issue' ? '#42 Test issue' : '@Test reference'
      const reference = `[$${label}](wework-${kind}://test-project/test-id)`
      const [mention] = parseComposerMentions(reference)
      expect(mention).toMatchObject({ name: label, label, reference })
      expect(composerSkillFilePath(reference)).toBeNull()
      const element = createComposerMentionElement(mention)
      expect(element).toHaveAttribute('data-composer-reference-kind', kind)
      expect(element.textContent).toBe(label.slice(1))
    }
  )
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

describe('conversation references', () => {
  test('keeps encoded runtime metadata inside one atomic composer mention', () => {
    const reference = createConversationMentionReference('Source chat', {
      deviceId: 'local-device',
      taskId: 'source-task',
      runtimeHandle: {
        modelSelection: {
          modelName: 'Kimi K3 (OpenAI)',
        },
      },
    })

    expect(parseComposerMentions(reference)).toEqual([
      expect.objectContaining({
        name: 'Source chat',
        reference,
        start: 0,
        end: reference.length,
      }),
    ])
  })
})

describe('composer mention icons', () => {
  afterEach(() => {
    resetComposerAppsMemory()
  })

  test('uses a registered plugin brand icon', () => {
    const reference = '[$GitHub](plugin://github@openai-bundled)'
    registerComposerMentionIcon(reference, {
      url: 'https://example.com/github.png',
      contrastPad: true,
    })

    const element = createComposerMentionElement({
      name: 'GitHub',
      label: 'GitHub',
      reference,
    })

    expect(element.querySelector('img')).toHaveAttribute('src', 'https://example.com/github.png')
    expect(element.querySelector('.composer-mention-icon-slot')).toHaveClass(
      'composer-mention-icon-slot--contrast-pad'
    )
  })

  test('skips the contrast pad when the registered icon does not need one', () => {
    const reference = '[$GitHub](plugin://github@openai-bundled)'
    registerComposerMentionIcon(reference, {
      url: 'https://example.com/github-dark.png',
      contrastPad: false,
    })

    const element = createComposerMentionElement({
      name: 'GitHub',
      label: 'GitHub',
      reference,
    })

    expect(element.querySelector('.composer-mention-icon-slot')).not.toHaveClass(
      'composer-mention-icon-slot--contrast-pad'
    )
  })

  test('keeps the generic cube icon when a plugin mention has no package logo', () => {
    const reference = '[$superpowers](plugin://superpowers@openai-official)'
    const element = createComposerMentionElement({
      name: 'superpowers',
      label: 'Superpowers',
      reference,
    })

    expect(element.querySelector('img')).toBeNull()
    expect(element.querySelector('svg.composer-mention-icon')).not.toBeNull()
  })

  test('uses the composer app inventory logo for connector-backed plugin mentions', () => {
    publishComposerApps([
      {
        id: 'wegent:dingtalk',
        name: '钉钉',
        pluginKey: 'dingtalk',
        description: null,
        logoUrl: 'https://example.com/dingtalk.png',
        isAccessible: true,
        isEnabled: true,
        source: 'wegent-connector',
      },
    ])

    const reference = '[$钉钉](plugin://dingtalk@wegent)'
    const element = createComposerMentionElement({
      name: '钉钉',
      label: '钉钉',
      reference,
    })

    expect(element.querySelector('img')).toHaveAttribute('src', 'https://example.com/dingtalk.png')
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
