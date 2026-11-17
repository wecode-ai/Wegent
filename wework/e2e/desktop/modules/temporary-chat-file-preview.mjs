import assert from 'node:assert/strict'
import { basename, join } from 'node:path'
import {
  assistantMessage,
  latestModelInputText,
  requestContainsToolOutput,
  selectShellToolCommand,
  toolOutputText,
} from './response-protocol.mjs'
import { selectedToolCall } from './model-tool-calls.mjs'

const PROMPT = 'TEMPORARY_CHAT_FILE_PREVIEW'
const COMPLETE = 'TEMPORARY_CHAT_FILES_COMPLETE'
const CALL_ID = 'temporary-chat-write-preview-files'
const WRITTEN = 'TEMPORARY_CHAT_FILES_VERIFIED'
const CODE_PATH = 'temporary preview/nested/result.mjs'
const HTML_PATH = 'temporary preview/nested/index.html'
const CODE_MARKER = 'TEMPORARY_CHAT_CODE_CONTENT'
const HTML_MARKER = 'TEMPORARY_CHAT_HTML_RENDERED'
const SOURCE_MARKER = 'TEMPORARY_CHAT_HTML_SOURCE'
const CODE = `// ${CODE_MARKER}\nexport const result = 42\n`
const HTML = `<!doctype html>\n<html><body>\n<h1>${HTML_MARKER}</h1>\n<!-- ${SOURCE_MARKER} -->\n</body></html>\n`
const FILE_TABS =
  '[data-workspace-tab-content][aria-hidden="false"] [data-testid^="right-workspace-file-tab"][role="tab"]'

function normalizedPath(path) {
  return path.replaceAll('\\', '/')
}

async function assertFileTabs(control, tabIds) {
  assert.equal(
    Number(await control.command('getElementCount', FILE_TABS)),
    tabIds.length,
    'Opening a temporary-chat file changed the number of retained file tabs'
  )
  for (const tabId of tabIds) {
    assert.equal(
      Number(
        await control.command(
          'getElementCount',
          `[data-testid=${JSON.stringify(tabId)}][role="tab"]`
        )
      ),
      1,
      'Opening a temporary-chat file replaced an existing file tab'
    )
  }
}

export function createTemporaryChatFilePreview(workspacePath) {
  let requested = false
  let verified = false
  return {
    matchesRequest(body) {
      return latestModelInputText(body).includes(PROMPT) || requestContainsToolOutput(body, CALL_ID)
    },
    responseEvents(body) {
      if (!requestContainsToolOutput(body, CALL_ID)) {
        assert.equal(requested, false, 'The temporary-chat file tool was requested twice')
        requested = true
        const script = [
          "const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')",
          `for (const [name, content] of ${JSON.stringify([
            [CODE_PATH, CODE],
            [HTML_PATH, HTML],
          ])}) { const file = path.join(process.cwd(), name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); assert.equal(fs.readFileSync(file, 'utf8'), content) }`,
          `console.log(${JSON.stringify(WRITTEN)})`,
        ].join('; ')
        const encoded = Buffer.from(script).toString('base64')
        const command = `node -e "eval(Buffer.from('${encoded}','base64').toString('utf8'))"`
        return selectedToolCall(
          CALL_ID,
          selectShellToolCommand(body, command, workspacePath, { yieldTimeMs: 10000 })
        )
      }
      const output = toolOutputText(body, CALL_ID)
      assert.match(output, /Exit code: 0|exit_code\W*0|Process exited with code 0/)
      assert.match(output, new RegExp(WRITTEN))
      verified = true
      return [
        assistantMessage(
          [
            COMPLETE,
            `[Temporary code](<${CODE_PATH}>)`,
            `[Temporary HTML](<${HTML_PATH}>)`,
            `[Temporary source lines](<${HTML_PATH}:3-4>)`,
          ].join('\n\n')
        ),
      ]
    },
    async verify(control, { sourceAddress, sideTaskId, sideChatSelector, sideComposerSelector }) {
      await control.command('fill', sideComposerSelector, { value: PROMPT })
      await control.command(
        'clickWhenEnabled',
        `${sideChatSelector} [data-testid="send-message-button"]`
      )
      await control.command('waitFor', `${sideChatSelector} [data-testid="message-assistant"]`, {
        text: COMPLETE,
      })
      assert.ok(requested && verified, 'The temporary chat did not execute the real file write')
      const chatTabId = await control.command(
        'getAttribute',
        '[data-testid^="right-workspace-chat-tab-"][role="tab"][aria-selected="true"]',
        { value: 'data-testid' }
      )
      assert.ok(chatTabId, 'The temporary chat did not retain its selected tab')
      const panel = '[data-testid="workspace-file-panel"]'
      const returnToChat = async () => {
        await control.command(
          'clickWhenEnabled',
          `[data-testid=${JSON.stringify(chatTabId)}][role="tab"]`
        )
        await control.command('waitFor', sideComposerSelector, { visible: true })
      }
      const openLink = async (label, relative) => {
        await control.command(
          'clickElementWithText',
          `${sideChatSelector} [data-testid="assistant-markdown-link"]`,
          {
            text: label,
            visible: true,
          }
        )
        await control.command('waitFor', panel, { visible: true })
        assert.equal(
          await control.command('getAttribute', panel, { value: 'data-workspace-device-id' }),
          sourceAddress.deviceId
        )
        await control.command('waitFor', `${panel} [data-testid="workspace-file-path"]`, {
          text: basename(relative),
        })
        assert.equal(
          normalizedPath(
            await control.command('getText', `${panel} [data-testid="workspace-file-path"]`)
          ),
          normalizedPath(join(sourceAddress.workspacePath, relative)),
          'The temporary-chat link opened a different workspace file'
        )
        const tabId = await control.command('getAttribute', `${FILE_TABS}[aria-selected="true"]`, {
          value: 'data-testid',
        })
        assert.ok(tabId, 'The temporary-chat file did not activate a file tab')
        return tabId
      }
      const codeTabId = await openLink('Temporary code', CODE_PATH)
      await control.command('waitFor', '[data-testid="workspace-file-editor-content"]', {
        text: 'export const result = 42',
        visible: true,
      })
      await assertFileTabs(control, [codeTabId])
      await returnToChat()
      const htmlTabId = await openLink('Temporary HTML', HTML_PATH)
      assert.notEqual(htmlTabId, codeTabId, 'Different files reused the same tab')
      await assertFileTabs(control, [codeTabId, htmlTabId])
      const htmlPreview = `${panel} [data-testid="workspace-html-file-preview"]`
      await control.command('waitFor', htmlPreview, { visible: true })
      assert.match(
        await control.command('getAttribute', `${htmlPreview} iframe`, { value: 'srcdoc' }),
        new RegExp(HTML_MARKER)
      )
      await returnToChat()
      assert.equal(
        await openLink('Temporary code', CODE_PATH),
        codeTabId,
        'Reopening the code file created a new tab'
      )
      await assertFileTabs(control, [codeTabId, htmlTabId])
      await control.command('waitFor', '[data-testid="workspace-file-editor-content"]', {
        text: 'export const result = 42',
        visible: true,
      })
      await returnToChat()
      assert.equal(
        await openLink('Temporary source lines', HTML_PATH),
        htmlTabId,
        'A line-targeted HTML link created a new tab'
      )
      await assertFileTabs(control, [codeTabId, htmlTabId])
      const sourceEditor = '[data-testid="workspace-file-editor-content"]'
      await control.command('waitFor', sourceEditor, {
        text: SOURCE_MARKER,
        visible: true,
      })
      assert.equal(
        Number(await control.command('getElementCount', htmlPreview, { visible: true })),
        0,
        'A line-targeted HTML link did not open source mode'
      )
      await control.command('nativePress', sourceEditor, {
        key: process.platform === 'darwin' ? 'Meta+C' : 'Control+C',
      })
      assert.equal(
        (await control.command('getClipboardText', 'body')).replaceAll('\r\n', '\n'),
        HTML.split('\n').slice(2, 4).join('\n'),
        'The HTML source selection did not contain exactly lines 3–4'
      )
      await returnToChat()
      const snapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
      assert.equal(
        (snapshot.pane?.currentRuntimeTask ?? snapshot.workbench?.currentRuntimeTask)?.taskId,
        sourceAddress.taskId,
        'Opening a temporary-chat file replaced the main task'
      )
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            `[data-testid="runtime-local-task-row-${sideTaskId}"]`
          )
        ),
        0,
        'Opening a temporary-chat file exposed the ephemeral task in the sidebar'
      )
    },
  }
}
