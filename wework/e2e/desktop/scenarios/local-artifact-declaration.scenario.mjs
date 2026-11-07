import { selectedToolCall } from '../modules/model-tool-calls.mjs'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { createSingleRootLocalProject, selectE2EModel } from '../modules/shared.mjs'
import { waitForRuntimePaneReadyToSend } from '../modules/streaming-text-fixture.mjs'
import {
  assistantMessage,
  codexRequestKind,
  createSse,
  customToolCall,
  functionCall,
  readRequestBody,
  requestContainsToolOutput,
  requestAdvertisesProgrammaticExec,
  responseCompleted,
  responseCreated,
  selectShellToolCommand,
  selectProgrammaticExec,
} from '../modules/response-protocol.mjs'

const PROMPT = 'WEWORK_LOCAL_ARTIFACT_DECLARATION'
const COMPLETE = 'LOCAL_ARTIFACT_DECLARATION_COMPLETE'
const CONTENT = '# Local deliverable\nGenerated without a Backend Task.\n'
const NAME = process.platform === 'win32' ? 'local report.md' : String.raw`\\local report\2026.md`
const PANE = '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const CARD = `${PANE} [data-testid="codex-reference-card"]`

export function createDesktopScenario({ workspacePath, uiTimeoutMs, workbenchReadyTimeoutMs }) {
  let active = false
  let requested = false
  let artifact
  let declarationDiagnostics = null

  async function verifyPreview(control) {
    await control.command('waitFor', CARD, { text: NAME, timeoutMs: uiTimeoutMs })
    assert.equal(Number(await control.command('getElementCount', CARD)), 1)
    await control.command('click', CARD)
    await control.command('waitFor', '[data-testid="workspace-file-path"]', {
      text: artifact.local_path,
    })
    await control.command('waitFor', '[data-testid="workspace-file-editor-content"]', {
      text: 'Generated without a Backend Task.',
    })
  }

  return {
    async handleHttp(req, res, url) {
      if (
        !active ||
        req.method !== 'POST' ||
        !['/responses', '/v1/responses'].includes(url.pathname)
      )
        return false
      const body = await readRequestBody(req)
      if (!JSON.stringify(body).includes(PROMPT)) return false
      const id = `local-artifact-${Date.now()}`
      let events
      if (codexRequestKind(body) === 'prewarm') events = [assistantMessage('Ready')]
      else if (!requestContainsToolOutput(body)) {
        assert.equal(requested, false, 'The declaration command must run only once')
        requested = true
        // The shell can merge startup stderr after stdout; terminate the metadata marker.
        const script = String.raw`const fs=require('fs'),p=require('path'),cp=require('child_process'),root=process.env.WEGENT_TASK_WORKSPACE;if(!root||process.env.WEGENT_BACKEND_TASK_ID)throw Error('Expected a runtime-only conversation');fs.mkdirSync(root,{recursive:true});fs.writeFileSync(p.join(root,${JSON.stringify(NAME)}),${JSON.stringify(CONTENT)});const out=cp.execFileSync(process.env.WEGENT_EXECUTOR_BINARY,['artifact','declare','--path',${JSON.stringify(NAME)}],{cwd:root,encoding:'utf8'});const line=out.split(/\r?\n/).find(s=>s.startsWith('[WEGENT_ARTIFACT]'));if(!line)throw Error(out);process.stdout.write('LOCAL_ARTIFACT_RESULT:'+Buffer.from(line.slice('[WEGENT_ARTIFACT]'.length)).toString('base64')+'\n');`
        const encoded = Buffer.from(script).toString('base64')
        const command = `node -e "eval(Buffer.from('${encoded}','base64').toString('utf8'))"`
        if (requestAdvertisesProgrammaticExec(body)) {
          const tool = selectProgrammaticExec(
            body,
            `text(await tools.exec_command(${JSON.stringify({ cmd: command, workdir: workspacePath, yield_time_ms: 10000 })}))`
          )
          const event = selectedToolCall('local-artifact-generate', { codeMode: tool }).at(-1)
          events = [event]
        } else {
          const tool = selectShellToolCommand(body, command, workspacePath, { yieldTimeMs: 10000 })
          events = selectedToolCall('local-artifact-generate', tool)
        }
      } else {
        const outputs = body.input.filter(item =>
          ['function_call_output', 'custom_tool_call_output'].includes(item.type)
        )
        const text = JSON.stringify(outputs)
        const result = text.match(/LOCAL_ARTIFACT_RESULT:([A-Za-z0-9+/=]+)/)
        assert.ok(result, `Real local declaration failed: ${text.slice(0, 4000)}`)
        const decoded = Buffer.from(result[1], 'base64')
        declarationDiagnostics = {
          encodedLength: result[1].length,
          decodedBytes: decoded.length,
          encodedTail: result[1].slice(-128),
          decodedTail: decoded.toString('utf8').slice(-160),
          outputAfterMarker: text.slice(result.index + result[0].length).slice(0, 80),
        }
        artifact = JSON.parse(decoded.toString('utf8'))
        assert.equal(artifact.name, NAME)
        assert.equal(artifact.relative_path, NAME)
        assert.equal(artifact.file_size, Buffer.byteLength(CONTENT))
        assert.match(artifact.sha256, /^[a-f0-9]{64}$/)
        assert.equal(await readFile(artifact.local_path, 'utf8'), CONTENT)
        events = [
          assistantMessage(
            `${COMPLETE}\n\n[${NAME}](<${encodeURI(artifact.local_path)}>)\n\n[Relative file](<${encodeURI(artifact.relative_path)}>)`
          ),
        ]
      }
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      res.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },

    diagnostics() {
      return { active, requested, declaration: declarationDiagnostics }
    },

    async verify(control) {
      await createSingleRootLocalProject(control, workspacePath, 'local-artifact-e2e', uiTimeoutMs)
      await selectE2EModel(control)
      active = true
      const composer = `${PANE} [data-testid="chat-message-input"][contenteditable="true"]`
      await control.command('fill', composer, { value: PROMPT })
      await control.command('clickWhenEnabled', `${PANE} [data-testid="send-message-button"]`, {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', `${PANE} [data-testid="message-assistant"]`, {
        text: COMPLETE,
        timeoutMs: workbenchReadyTimeoutMs,
      })
      assert.ok(requested && artifact, 'The real CLI must have returned local metadata')
      await waitForRuntimePaneReadyToSend(control, uiTimeoutMs)
      await control.command(
        'click',
        `${PANE} [data-testid="assistant-markdown-link"][aria-label=${JSON.stringify(artifact.relative_path)}]`
      )
      await control.command('waitFor', '[data-testid="workspace-file-path"]', {
        text: artifact.local_path,
      })
      await control.command('waitFor', '[data-testid="workspace-file-editor-content"]', {
        text: 'Generated without a Backend Task.',
      })
      await verifyPreview(control)
      const readyCount = control.readyCount
      await control.command('reloadMainWindow', 'body')
      await control.awaitReadyAfter(readyCount)
      await verifyPreview(control)
    },
  }
}
