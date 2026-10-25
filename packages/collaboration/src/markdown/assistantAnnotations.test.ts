import { describe, expect, test } from 'vitest'
import { collectAssistantAnnotations, extractAssistantFileCitations } from './assistantAnnotations'

describe('assistant annotation protocol', () => {
  test.each([
    [String.raw`:codex-file-citation{path="C:\repo\" purpose=output}`, 'C:\\repo\\'],
    [String.raw`:codex-file-citation{path="/tmp/a\"b" label="team's \"report\""}`, '/tmp/a"b'],
    [":codex-file-citation{path='/tmp/report.xlsx' purpose=source}", '/tmp/report.xlsx'],
    [':codex-file-citation{path=file:///tmp/report%20a?x#L1:10}', '/tmp/report%20a?x#L1:10'],
    ['【/tmp/report%20final.txt†L3-L8】', '/tmp/report final.txt'],
    [':::codex-file-citation{path=/tmp/report.xlsx}', '/tmp/report.xlsx'],
  ])('preserves protocol path semantics in %s', (content, path) => {
    expect(extractAssistantFileCitations(content)).toMatchObject([{ path }])
  })

  test.each([
    ':codex-file-citation{path=""}',
    ':codex-file-citation{path=one path=two}',
    ':codex-file-citation{path="/tmp/report.xlsx" purpose=invalid}',
    ':codex-file-citation[caption]{path=foo}',
    ':codex-file-citation{path="unfinished}',
    '\\:codex-file-citation{path=foo}',
    ':outer{value=":codex-file-citation{path=foo}"}',
    '[file]: :codex-file-citation{path=foo}\n\n[file]',
    "<span title=':codex-file-citation{path=foo}'>",
    '【turn0search1†L3】',
  ])('does not invent file references for %s', content => {
    expect(extractAssistantFileCitations(content)).toEqual([])
  })

  test('does not limit the number of valid references', () => {
    expect(
      extractAssistantFileCitations(':codex-file-citation{path=/tmp/report.xlsx} '.repeat(512))
    ).toHaveLength(512)
  })

  test('bounds malformed directive scanning without swallowing subsequent paragraphs', () => {
    expect(
      extractAssistantFileCitations(
        ':x{v='.repeat(16000) + '\n\n:codex-file-citation{path=report.xlsx}'
      )
    ).toMatchObject([{ path: 'report.xlsx' }])
    expect(extractAssistantFileCitations(':codex-file-citation{path=report.xlsx}')).toMatchObject([
      { path: 'report.xlsx' },
    ])
  })

  test.each([
    'Type a ` character',
    'Format `array[0]`',
    'Explain `]` and **charts**',
    'Review [the report](https://example.com)',
  ])('parses follow-up labels containing Markdown: %s', label => {
    expect(
      collectAssistantAnnotations(`:codex-followup[${label}]{prompt="Continue"}`)
    ).toMatchObject([{ annotation: { kind: 'followup', label, prompt: 'Continue' } }])
  })

  test('leaves examples of opaque content references inside code intact', () => {
    expect(collectAssistantAnnotations('`\uE200cite\uE202turn0search1\uE201`')).toEqual([])
  })
})
