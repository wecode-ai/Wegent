import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { AssistantMarkdown } from './AssistantMarkdown'
import { copyTextToClipboard } from '@/lib/clipboard'

vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: vi.fn() }))

const source =
  '/Users/axb-mac/Documents/Codex/2026-10-24/1-2-2027-ai-native-3-97098936/.build/source/original.pptx'

test('renders the reported source citation and opens the exact original presentation', () => {
  const onOpenFile = vi.fn()
  render(
    <AssistantMarkdown
      content={`原稿依据：\n\n:codex-file-citation{path="${source}" purpose="source"}`}
      onOpenFile={onOpenFile}
    />
  )
  const link = screen.getByRole('button', { name: source })
  expect(link).toHaveTextContent('original.pptx')
  expect(link).toHaveAttribute('data-citation-purpose', 'source')
  expect(document.body).not.toHaveTextContent('codex-file-citation')
  fireEvent.click(link)
  expect(onOpenFile).toHaveBeenCalledExactlyOnceWith(source)
})

test.each([
  '/tmp/a*b*.txt',
  '/tmp/$x$/report.md',
  '/tmp/a`b`.txt',
  '/tmp/a<b>.txt',
  '/tmp/report#L10',
  '/tmp/report:10',
  '/tmp/report%20final.xlsx',
  '/tmp/report?final.xlsx',
  'reports/中文 空格 (final).xlsx',
  String.raw`C:\Users\me\report.xlsx`,
  'C:\\repo\\',
  '/tmp/team&report.txt',
])('preserves the literal citation path %s', path => {
  const onOpenFile = vi.fn()
  render(
    <AssistantMarkdown
      content={`See :codex-file-citation{path="${path}" purpose="output"}.`}
      onOpenFile={onOpenFile}
    />
  )
  fireEvent.click(screen.getByTestId('assistant-markdown-link'))
  expect(onOpenFile).toHaveBeenCalledExactlyOnceWith(path)
})

test.each([
  ':codex-file-citation{path="src/index.ts" line_range_start="4" line_range_end="9"}',
  '::codex-file-citation{path=src/index.ts lineRangeStart=4 lineRangeEnd=9}',
  '【F:src/index.ts†L4-L9】',
])('opens line ranges for %s', content => {
  const onOpenFile = vi.fn()
  render(<AssistantMarkdown content={content} onOpenFile={onOpenFile} />)
  fireEvent.click(screen.getByTestId('assistant-markdown-link'))
  expect(onOpenFile).toHaveBeenCalledWith('src/index.ts', {
    lineStart: 4,
    lineEnd: 9,
    isDirectory: undefined,
  })
})

test.each([
  ['artifact_kind=document page_number=3', 'page 3'],
  [
    'artifact_kind=presentation slide_number=2 object_id=shape1 label="Revenue"',
    'slide 2, Revenue',
  ],
  ['artifact_kind=workbook sheet="Q1=Actual" range="A1:D8"', 'Q1=Actual!A1:D8'],
  [
    'artifact_kind=workbook sheet="Dashboard" object_id=chart1 label="Revenue"',
    'Dashboard, Revenue',
  ],
])('renders artifact location %s', (attributes, expected) => {
  render(<AssistantMarkdown content={`:codex-file-citation{path="/tmp/report" ${attributes}}`} />)
  expect(screen.getByTestId('assistant-markdown-link')).toHaveTextContent(expected)
  expect(screen.getByTestId('assistant-markdown-link')).toBeDisabled()
})

const citation = ':codex-file-citation{path="/tmp/report.xlsx"}'
test.each([
  `\`${citation}\``,
  `\`\`\`text\n${citation}\n\`\`\``,
  `    ${citation}`,
  `\\${citation}`,
  `&#58;${citation.slice(1)}`,
  `[${citation}](https://example.com)`,
  `:unsupported{value='${citation}'}`,
  `::::${citation.slice(1)}`,
])('keeps literal Markdown boundaries in %s', content => {
  render(<AssistantMarkdown content={content} />)
  expect(document.querySelector('[data-citation-purpose]')).toBeNull()
})

test('does not turn directive examples in user messages into file controls', () => {
  render(<AssistantMarkdown content={citation} variant="user" />)
  expect(screen.queryByTestId('assistant-markdown-link')).not.toBeInTheDocument()
  expect(document.body).toHaveTextContent(citation)
})

test('keeps adjacent text, entities, emphasis and multiple citations intact', () => {
  render(
    <AssistantMarkdown
      content={`Préface &amp; **${citation}** &#x1F642; ${citation} &lt;fin&gt;`}
    />
  )
  expect(screen.getAllByTestId('assistant-markdown-link')).toHaveLength(2)
  expect(document.body).toHaveTextContent('Préface & report.xlsx 🙂 report.xlsx <fin>')
  expect(screen.getAllByTestId('assistant-markdown-link')[0].closest('strong')).not.toBeNull()
})

test.each(['> ', '> > '])('preserves multiline blockquote content with prefix %s', prefix => {
  render(
    <AssistantMarkdown
      content={`${prefix}Before &amp;\n${prefix}${citation}\n${prefix}After &lt;end&gt;`}
    />
  )
  expect(screen.getByTestId('assistant-markdown-link').closest('blockquote')).not.toBeNull()
  expect(document.querySelector('blockquote')).toHaveTextContent('Before & report.xlsx After <end>')
})

test('hides incomplete streaming attributes and reveals the complete file reference', () => {
  const { rerender } = render(
    <AssistantMarkdown content={'原稿：:codex-file-citation{path="/tmp/private'} isStreaming />
  )
  expect(document.body).not.toHaveTextContent('private')
  expect(screen.queryByTestId('assistant-markdown-link')).not.toBeInTheDocument()
  rerender(<AssistantMarkdown content={`原稿：${citation}`} />)
  expect(screen.getByTestId('assistant-markdown-link')).toHaveTextContent('report.xlsx')
})

test('renders citations in tables without changing the table source copied by the user', () => {
  render(<AssistantMarkdown content={`| Source |\n| --- |\n| ${citation} |`} />)
  expect(screen.getByTestId('assistant-markdown-link')).toHaveAttribute(
    'data-citation-purpose',
    'output'
  )
  expect(screen.getByTestId('markdown-table')).toHaveTextContent('report.xlsx')
})

test('preserves opaque citation examples and removes unresolved metadata across lines', () => {
  render(
    <AssistantMarkdown
      content={
        '`\uE200cite\uE202example\uE201`\n\nBefore \uE200filecite\uE202turn1\n\nturn2\uE201 After'
      }
    />
  )
  expect(document.querySelector('code')).toHaveTextContent('\uE200cite\uE202example\uE201')
  expect(document.body).toHaveTextContent('Before')
  expect(document.body).toHaveTextContent('After')
  expect(document.body).not.toHaveTextContent('turn1')
  expect(document.body).not.toHaveTextContent('turn2')
})

test('keeps follow-up Markdown labels readable without nesting link actions', () => {
  render(
    <AssistantMarkdown
      content={
        ':codex-followup[Explain `]` and [the report](https://example.com)]{prompt=Continue}'
      }
    />
  )
  const button = screen.getByTestId('assistant-followup-copy')
  expect(button).toHaveTextContent('Explain ] and the report')
  expect(button.querySelector('a, button')).toBeNull()
})

test('preserves underscore emphasis in follow-up labels', () => {
  render(<AssistantMarkdown content={':codex-followup[Explain _charts_]{prompt=Continue}'} />)
  expect(screen.getByTestId('assistant-followup-copy').querySelector('em')).toHaveTextContent(
    'charts'
  )
})

test.each(['javascript:alert(1)', 'data:text/html,hello', 'https://example.com/report.xlsx'])(
  'does not interpret %s as a local file',
  path => {
    render(<AssistantMarkdown content={`:codex-file-citation{path="${path}"}`} />)
    expect(document.querySelector('[data-citation-purpose]')).toBeNull()
  }
)

test('renders a follow-up label and copies only its prompt on explicit activation', async () => {
  vi.mocked(copyTextToClipboard).mockResolvedValue(undefined)
  render(
    <AssistantMarkdown
      content={
        'Next: :codex-followup[Add **charts**]{prompt="Add a \\"Q3\\" chart with } labels"}.'
      }
    />
  )
  const button = screen.getByTestId('assistant-followup-copy')
  expect(button).toHaveTextContent('Add charts')
  expect(document.body).not.toHaveTextContent('prompt=')
  expect(copyTextToClipboard).not.toHaveBeenCalled()
  fireEvent.click(button)
  await vi.waitFor(() =>
    expect(copyTextToClipboard).toHaveBeenCalledWith('Add a "Q3" chart with } labels')
  )
})
