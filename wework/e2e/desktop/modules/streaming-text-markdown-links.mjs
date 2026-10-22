import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  openNewChatWithE2EModel,
  waitForRuntimePaneReadyToSend,
} from './streaming-text-fixture.mjs'

const WORKBENCH = '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const COMPOSER = `${WORKBENCH} [data-testid="chat-message-input"][contenteditable="true"]`
const ASSISTANT = `${WORKBENCH} [data-testid="assistant-message-content"]`
const LINKS = `${ASSISTANT} [data-testid="assistant-markdown-link"]`
const SQL = "regexp_extract(analysis_extra, 'cate[=:]([0-9]+)', 1)"
export const MARKDOWN_LINKS_PROMPT = `WEWORK_E2E_MARKDOWN_ORIGINAL_LINKS: explain \`${SQL}\``
const FILE_TEXT = 'export const markdownOriginalLink = true'
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAIAAAACUFjqAAAAEklEQVR4nGP4z8CAB+GTG8HSALfKY52fTcuYAAAAAElFTkSuQmCC'

async function verifyOriginalCode(control) {
  assert.equal(await control.command('getText', `${ASSISTANT} p code`), SQL)
  assert.equal(await control.command('getText', `${ASSISTANT} pre code`), SQL)
  await control.command('click', `${ASSISTANT} [data-testid="markdown-code-copy-button"]`)
  await control.command('waitFor', `${ASSISTANT} [data-testid="markdown-code-copy-success-icon"]`)
  assert.equal(await control.command('getClipboardText', ''), SQL)
  assert.equal(
    await control.command('getText', `${WORKBENCH} [data-testid="message-user"] code`),
    SQL
  )
  const snapshot = JSON.parse(await control.command('snapshot', ASSISTANT))
  assert.ok(!snapshot.text.includes('wework.local'), 'A placeholder URL leaked into Markdown')
  assert.ok(!snapshot.text.includes('[blocked]'), 'A supported file link was blocked')
}

async function openLink(control, label) {
  await control.command('clickElementWithText', LINKS, { text: label })
}

export function createMarkdownLinkChecks({ captureScreenshot, workspacePath, uiTimeoutMs }) {
  const directory = join(workspacePath, 'markdown links')
  const filePath = join(directory, 'report.ts')
  const imagePath = join(directory, 'plot.png')
  const table = `| File |\n| --- |\n| [Table file](<${filePath}>) |`
  const completion = [
    `\`${SQL}\``,
    '',
    '```sql',
    SQL,
    '```',
    '',
    `[File link](<${filePath}:1>)`,
    `[File URI](${pathToFileURL(filePath).href})`,
    `[Directory URI](folder://${directory.replaceAll('\\', '/').replaceAll(' ', '%20')})`,
    '',
    table,
    '',
    `![Local plot](${pathToFileURL(imagePath).href})`,
  ].join('\n')

  return {
    completion,

    async verify(control) {
      await mkdir(directory, { recursive: true })
      await writeFile(filePath, FILE_TEXT + '\n')
      await writeFile(imagePath, Buffer.from(PNG, 'base64'))
      await openNewChatWithE2EModel(control, uiTimeoutMs)
      await control.command('fill', COMPOSER, { value: MARKDOWN_LINKS_PROMPT })
      await control.command('press', COMPOSER, { key: 'Enter' })
      await control.command('waitFor', `${ASSISTANT} pre code`, { text: SQL })
      await waitForRuntimePaneReadyToSend(control, uiTimeoutMs)
      await verifyOriginalCode(control)
      await control.command('waitFor', `${ASSISTANT} img[alt="Local plot"]`, { visible: true })
      assert.match(
        await control.command('getAttribute', `${ASSISTANT} img[alt="Local plot"]`, {
          value: 'src',
        }),
        /^blob:/,
        'The local image was not read through the Wework file service'
      )
      await control.command('click', `${ASSISTANT} [data-testid="markdown-table-copy-button"]`)
      await control.command(
        'waitFor',
        `${ASSISTANT} [data-testid="markdown-table"] [role="status"]`,
        {
          text: '已复制',
        }
      )
      assert.equal(await control.command('getClipboardText', ''), table)
      await captureScreenshot(control, 'markdown-links-01-original-content.png', WORKBENCH)

      for (const label of ['File link', 'File URI', 'Table file']) {
        await openLink(control, label)
        await control.command('waitFor', '[data-testid="workspace-file-editor"] .cm-content', {
          text: FILE_TEXT,
        })
        assert.equal(
          await control.command('getText', '[data-testid="workspace-file-path"]'),
          filePath.replaceAll('\\', '/')
        )
      }
      await openLink(control, 'Directory URI')
      await control.command('waitFor', '[data-testid="workspace-file-tree-pierre"]')
      await control.command('waitFor', 'button[data-type="item"][aria-label="report.ts"]')
      await captureScreenshot(control, 'markdown-links-02-local-file-open.png', 'body')

      const readyCount = control.readyCount
      await control.command('reloadMainWindow', 'body')
      await control.awaitReadyAfter(readyCount)
      await control.command('waitFor', `${ASSISTANT} pre code`, {
        text: SQL,
        timeoutMs: uiTimeoutMs,
      })
      await verifyOriginalCode(control)
      await control.command('click', '[data-testid="toggle-right-workspace-panel-button"]')
    },
  }
}
