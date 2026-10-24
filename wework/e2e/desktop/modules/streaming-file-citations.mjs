import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  assistantMessage,
  latestModelInputText,
  openNewChatWithE2EModel,
  responseCompleted,
  responseCreated,
  sse,
  waitForRuntimePaneReadyToSend,
} from './streaming-text-fixture.mjs'

const PROMPT = 'WEWORK_FILE_CITATION_PROTOCOL'
const WORKBENCH = '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const ASSISTANT = `${WORKBENCH} [data-testid="assistant-message-content"]`
const LINK = `${ASSISTANT} [data-testid="assistant-markdown-link"]`
const CONTENT = 'export const citationProtocol = true'

export function createFileCitationChecks({ workspacePath, uiTimeoutMs }) {
  const directory = join(workspacePath, 'file citations')
  const source = join(directory, 'original.ts').replaceAll('\\', '/')
  const output = join(directory, 'result.ts').replaceAll('\\', '/')
  const completion = [
    `原稿依据：:codex-file-citation{path="${source}" purpose="source"}`,
    `输出：::codex-file-citation{path="${output}" purpose="output" line_range_start=1}`,
    `旧式引用：【F:${output}†L1】`,
    ':codex-followup[Explain this result]{prompt="Explain the citation result"}',
    '`' + ':codex-file-citation{path="example-only.md"}' + '`',
  ].join('\n\n')

  async function verifyLinks(control) {
    assert.equal(
      await control.command('getAttribute', `${LINK}[data-citation-purpose="output"]`, {
        value: 'aria-label',
      }),
      `${output} (line 1)`
    )
    for (const purpose of ['source', 'output']) {
      await control.command('click', `${LINK}[data-citation-purpose="${purpose}"]`)
      await control.command('waitFor', '[data-testid="workspace-file-editor"] .cm-content', {
        text: CONTENT,
      })
      assert.equal(
        await control.command('getText', '[data-testid="workspace-file-path"]'),
        purpose === 'source' ? source : output
      )
    }
    assert.equal(
      await control.command('getText', `${ASSISTANT} p code`),
      ':codex-file-citation{path="example-only.md"}'
    )
    await control.command('click', `${ASSISTANT} [data-testid="assistant-followup-copy"]`)
    await control.command('waitFor', `${ASSISTANT} [data-testid="assistant-followup-copy"]`, {
      text: 'Explain this result',
    })
    assert.equal(await control.command('getClipboardText', ''), 'Explain the citation result')
  }

  return {
    async handleModelRequest(body, response, id) {
      if (!latestModelInputText(body).includes(PROMPT)) return false
      const reply = assistantMessage(completion, 'final_answer')
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      response.end(sse([responseCreated(id), reply, responseCompleted(id, [reply.item])]))
      return true
    },
    async verify(control) {
      await mkdir(directory, { recursive: true })
      await writeFile(source, CONTENT + '\n')
      await writeFile(output, CONTENT + '\n')
      await openNewChatWithE2EModel(control, uiTimeoutMs)
      const composer = `${WORKBENCH} [data-testid="chat-message-input"][contenteditable="true"]`
      await control.command('fill', composer, { value: PROMPT })
      await control.command('press', composer, { key: 'Enter' })
      await control.command('waitFor', `${LINK}[data-citation-purpose="output"]`, {
        text: 'result.ts',
      })
      await waitForRuntimePaneReadyToSend(control, uiTimeoutMs)
      await verifyLinks(control)
      const readyCount = control.readyCount
      await control.command('reloadMainWindow', 'body')
      await control.awaitReadyAfter(readyCount)
      await control.command('waitFor', `${LINK}[data-citation-purpose="output"]`, {
        text: 'result.ts',
        timeoutMs: uiTimeoutMs,
      })
      await verifyLinks(control)
      await control.command('click', '[data-testid="toggle-right-workspace-panel-button"]')
    },
  }
}
