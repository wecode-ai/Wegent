import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  createSingleRootLocalProject,
  selectE2EModel,
} from '../modules/shared.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { requestContainsSkillLocator } from '../modules/desktop-server.mjs'
import { until } from '../modules/plugin-regression-fixture.mjs'
import {
  assistantMessage,
  createSse,
  customToolCall,
  functionCall,
  handleEmptyReplyPrediction,
  readRequestBody,
  requestAdvertisesProgrammaticExec,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
  selectProgrammaticExec,
  selectShellToolCommand,
} from '../modules/response-protocol.mjs'

const PROMPT = 'WEWORK_DOCS_OFFLINE_STORY 使用 $wework-docs 查询中英文任务文档并引用来源。'
const COMPLETE = 'WEWORK_DOCS_OFFLINE_READ_COMPLETE'
const CALL = 'wework-docs-read'
const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const hash = value => createHash('sha256').update(value).digest('hex')

// Only the model service is simulated. Installation, discovery, and reads use real components.
export function createDesktopScenario({
  workspacePath,
  resultDir,
  uiTimeoutMs,
  workbenchReadyTimeoutMs,
  restartDesktopApp,
}) {
  let skillPath
  let active = false
  let requested = false
  let evidence
  let expected

  return {
    diagnostics() {
      return { skillPath, requested, hashes: evidence, expected }
    },
    async handleHttp(request, response, url) {
      if (
        !active ||
        request.method !== 'POST' ||
        !['/responses', '/v1/responses'].includes(url.pathname)
      )
        return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      if (!JSON.stringify(body).includes('WEWORK_DOCS_OFFLINE_STORY')) return false
      let events
      if (!requestContainsToolOutput(body, CALL)) {
        assert.equal(requested, false, 'The documentation read was submitted twice')
        assert.ok(
          requestContainsSkillLocator(body, skillPath),
          'Default skill is missing from the real model context'
        )
        requested = true
        const paths = [
          skillPath,
          join(dirname(skillPath), 'references/zh/tasks.md'),
          join(dirname(skillPath), 'references/en/tasks.md'),
        ]
        const script = `const fs=require('node:fs'),crypto=require('node:crypto');const hashes=${JSON.stringify(paths)}.map(p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'));console.log('WEWORK_DOCS_RESULT:'+Buffer.from(JSON.stringify(hashes)).toString('base64'))`
        const command = `node -e "eval(Buffer.from('${Buffer.from(script).toString('base64')}','base64').toString('utf8'))"`
        if (requestAdvertisesProgrammaticExec(body)) {
          const tool = selectProgrammaticExec(
            body,
            `text(await tools.exec_command(${JSON.stringify({ cmd: command, workdir: workspacePath, yield_time_ms: 10000 })}))`
          )
          const event = customToolCall(CALL, tool.name, tool.input)
          event.item.namespace = 'functions'
          events = [event]
        } else {
          const tool = selectShellToolCommand(body, command, workspacePath, { yieldTimeMs: 10000 })
          events = functionCall(CALL, tool.name, tool.arguments)
        }
      } else {
        const output = JSON.stringify(
          body.input.filter(item =>
            ['function_call_output', 'custom_tool_call_output'].includes(item.type)
          )
        )
        const result = output.match(/WEWORK_DOCS_RESULT:([A-Za-z0-9+/=]+)/)
        assert.ok(result, `The real documentation read failed: ${output.slice(0, 4000)}`)
        evidence = JSON.parse(Buffer.from(result[1], 'base64').toString('utf8'))
        assert.deepEqual(
          evidence,
          expected,
          'Installed skill or manuals differ from this build source'
        )
        events = [
          assistantMessage(
            `${COMPLETE}\n\n[任务文档](<${join(dirname(skillPath), 'references/zh/tasks.md')}>)`
          ),
        ]
      }
      const id = `wework-docs-${Date.now()}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },
    async verify(control) {
      await createSingleRootLocalProject(control, workspacePath, 'wework-docs-story', uiTimeoutMs)
      await selectE2EModel(control)
      const installation = await until(
        async () => JSON.parse(await control.command('getBundledPluginUpdates', 'body')),
        state => state.states?.['wework-docs']?.status === 'ready',
        'Wework Docs was not automatically installed on first use',
        workbenchReadyTimeoutMs
      )
      assert.ok(installation.marketplace.defaultPluginNames.includes('wework-docs'))
      const catalog = await requestExecutor(
        control,
        'runtime.codex.app_server.request',
        {
          method: 'skills/list',
          params: { cwds: [workspacePath], forceReload: true },
        },
        uiTimeoutMs
      )
      const skills = catalog.data
        .flatMap(entry => entry.skills)
        .filter(skill => skill.name === 'wework-docs:wework-docs')
      assert.equal(skills.length, 1, 'Real Codex must discover exactly one built-in docs skill')
      assert.notEqual(skills[0].enabled, false, 'The default docs skill is disabled')
      skillPath = skills[0].path
      expected = await Promise.all(
        [
          join(
            repositoryRoot,
            'wework/resources/bundled-plugins/wework-personal/plugins/wework-docs/skills/wework-docs/SKILL.md'
          ),
          join(repositoryRoot, 'docs/zh/wework/tasks.md'),
          join(repositoryRoot, 'docs/en/wework/tasks.md'),
        ].map(async path => hash(await readFile(path)))
      )
      active = true
      await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: PROMPT })
      await control.command(
        'clickWhenEnabled',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`
      )
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
        {
          text: COMPLETE,
          timeoutMs: workbenchReadyTimeoutMs,
        }
      )
      assert.ok(
        requested && evidence,
        'The actual runtime did not finish reading its installed manuals'
      )
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="pause-response-button"]`,
        { visible: false }
      )
      // Restart with an older installed manual, as when launching an updated application.
      const installedManual = join(dirname(skillPath), 'references/zh/tasks.md')
      await restartDesktopApp({
        afterStop: () => writeFile(installedManual, 'WEWORK_DOCS_PREVIOUS_EDITION\n'),
      })
      await until(
        async () => JSON.parse(await control.command('getBundledPluginUpdates', 'body')),
        state => state.states?.['wework-docs']?.status === 'ready',
        'Wework Docs did not synchronize after restarting the application',
        workbenchReadyTimeoutMs
      )
      assert.equal(
        hash(await readFile(installedManual)),
        expected[1],
        'Startup retained an obsolete manual'
      )
      await writeFile(
        join(resultDir, 'wework-docs-story.json'),
        `${JSON.stringify({ skillPath, hashes: evidence, installedByDefault: true, obsoleteManualReplaced: true }, null, 2)}\n`
      )
    },
  }
}
