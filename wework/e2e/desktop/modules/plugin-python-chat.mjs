import assert from 'node:assert/strict'
import { access, copyFile, mkdir, writeFile } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'

import { accountCommandResult } from './account-auth-command.mjs'
import { shellCommandPollResponse, shellCommandResponse } from './shell-command-response.mjs'
import { assertManagedPythonHome, PYTHON_BOOTSTRAP_TIMEOUT_MS } from './managed-python.mjs'
import { createSingleRootLocalProject, selectE2EModel } from './shared.mjs'
import {
  assistantMessage,
  codexRequestKind,
  createSse,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from './response-protocol.mjs'

const PROMPT = 'WEWORK_PLUGIN_PYTHON_CHAT'
const COMPLETE = 'WEWORK_PLUGIN_PYTHON_CHAT_COMPLETE'
const CALL = 'plugin-python-chat'
const PANE = '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'

export function createPluginPythonChat({
  resultDir,
  workspacePath,
  electronUserDataDirectory,
  uiTimeoutMs,
}) {
  const plugin = join(resultDir, 'plugins', 'chat-python-plugin')
  const scriptPath = join(plugin, 'skills', 'example', 'scripts', 'inspect runtime.py')
  const localPlugin = join(resultDir, 'chat-python-local-plugin')
  const localScriptPath = join(localPlugin, 'skills', 'example', 'scripts', 'inspect runtime.py')
  let active = false
  let started = false
  let details
  let temporaryDetails

  // The command environment cannot resolve Python; only the host may select
  // a validated interpreter. Project import settings stay out of both children.
  const script = [
    `const cp=require('child_process'),assert=require('assert/strict');`,
    `process.env.PATH='';process.env.PYTHONHOME='task-python-home';process.env.PYTHONPATH='task-python-path';`,
    `const fingerprint=()=>require('crypto').createHash('sha256').update(JSON.stringify(Object.entries(process.env).sort())).digest('hex');const before=fingerprint();`,
    `assert.equal(cp.spawnSync('python3',['--version']).error.code,'ENOENT');`,
    `const temporary=cp.spawnSync(process.env.WEGENT_EXECUTOR_BINARY,['plugin-python',${JSON.stringify(localScriptPath)},'argument with spaces','中文'],{encoding:'utf8'});`,
    `if(temporary.error)throw temporary.error;assert.equal(temporary.status,0,temporary.stderr);`,
    `process.stdout.write(temporary.stdout.replace('PLUGIN_PYTHON_RESULT:','PLUGIN_SYSTEM_PYTHON_RESULT:'));`,
    `const output=cp.spawnSync(process.env.WEGENT_EXECUTOR_BINARY,['plugin-python',${JSON.stringify(scriptPath)},'argument with spaces','中文'],{encoding:'utf8',stdio:['ignore','pipe','pipe']});`,
    `if(output.error)throw output.error;process.stdout.write(output.stdout);process.stderr.write(output.stderr);assert.equal(output.status,0);`,
    `const ready=cp.spawnSync(process.env.WEGENT_EXECUTOR_BINARY,['plugin-python',${JSON.stringify(localScriptPath)},'ready'],{encoding:'utf8'});assert.equal(ready.status,0,ready.stderr);process.stdout.write(ready.stdout.replace('PLUGIN_PYTHON_RESULT:','PLUGIN_READY_PYTHON_RESULT:'));`,
    `const failed=cp.spawnSync(process.env.WEGENT_EXECUTOR_BINARY,['plugin-python',${JSON.stringify(scriptPath)},'--exit-seven'],{encoding:'utf8'});assert.equal(failed.status,7,failed.stderr);`,
    `assert.equal(fingerprint(),before,'The plugin changed its parent task environment');assert.equal(cp.spawnSync('python3',['--version']).error.code,'ENOENT');console.log('ORDINARY_TASK_ENVIRONMENT_PRESERVED');`,
  ].join('')
  const command = `node -e "eval(Buffer.from('${Buffer.from(script).toString('base64')}','base64').toString('utf8'))"`

  return {
    async prepare() {
      await mkdir(join(resultDir, '.agents', 'plugins'), { recursive: true })
      await writeFile(
        join(resultDir, '.agents', 'plugins', 'marketplace.json'),
        JSON.stringify({
          name: 'wework-personal',
          plugins: [
            {
              name: 'chat-python-plugin',
              version: '1.0.0',
              source: { source: 'local', path: './plugins/chat-python-plugin' },
            },
          ],
        })
      )
      await mkdir(join(plugin, '.codex-plugin'), { recursive: true })
      await mkdir(join(plugin, 'skills', 'example', 'scripts'), { recursive: true })
      await writeFile(
        join(plugin, '.codex-plugin', 'plugin.json'),
        JSON.stringify({ name: 'chat-python-plugin', version: '1.0.0', skills: './skills' })
      )
      await writeFile(
        join(plugin, 'skills', 'example', 'SKILL.md'),
        '---\nname: python-example\ndescription: Inspect plugin Python\n---\nRun python scripts/inspect runtime.py with the supplied arguments.\n'
      )
      await writeFile(
        scriptPath,
        `import base64, json, os, sys, runtime_probe_support\nprint('PLUGIN_PYTHON_RESULT:' + base64.b64encode(json.dumps({'version': sys.version.split()[0], 'executable': sys.executable, 'prefix': sys.base_prefix, 'cwd': os.getcwd(), 'args': sys.argv[1:], 'pythonhome': os.environ.get('PYTHONHOME'), 'pythonpath': os.environ.get('PYTHONPATH'), 'no_site': sys.flags.no_site, 'bridge_token': 'WEWORK_PYTHON_RUNTIME_TOKEN' in os.environ}).encode()).decode())\nsys.exit(7 if '--exit-seven' in sys.argv else 0)\n`
      )
      await mkdir(join(localPlugin, '.codex-plugin'), { recursive: true })
      await mkdir(join(localPlugin, 'skills', 'example', 'scripts'), { recursive: true })
      await writeFile(
        join(localPlugin, '.codex-plugin', 'plugin.json'),
        JSON.stringify({
          name: 'chat-python-local-plugin',
          version: '1.0.0',
          runtimeRequirements: {
            python: { systemFallback: { version: '3.12', dependencies: [] } },
          },
        })
      )
      await copyFile(scriptPath, localScriptPath)
      for (const root of [plugin, localPlugin]) {
        await writeFile(
          join(root, 'skills', 'example', 'scripts', 'runtime_probe_support.py'),
          'probe = "bundle-ok"\n'
        )
      }
    },
    async handleHttp(request, response, url) {
      if (
        !active ||
        request.method !== 'POST' ||
        !['/responses', '/v1/responses'].includes(url.pathname)
      )
        return false
      const body = await readRequestBody(request)
      if (!JSON.stringify(body).includes(PROMPT)) return false
      const id = `${CALL}-${Date.now()}`
      let events
      if (codexRequestKind(body) === 'prewarm') {
        events = [assistantMessage('Ready')]
      } else {
        assert.ok(
          JSON.stringify(body).includes('Wework Python plugin execution:'),
          'The real chat request must receive host-owned Python plugin routing'
        )
        const result = accountCommandResult(body.input, CALL)
        if (result?.sessionId) {
          events = shellCommandPollResponse(body, result.pollId, result.sessionId)
        } else if (result) {
          assert.ok(result.output.includes('ORDINARY_TASK_ENVIRONMENT_PRESERVED'), result.output)
          const encoded = result.output.match(/PLUGIN_PYTHON_RESULT:([A-Za-z0-9+/=]+)/)?.[1]
          assert.ok(encoded, 'The real plugin script did not finish')
          details = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
          const local = result.output.match(/PLUGIN_SYSTEM_PYTHON_RESULT:([A-Za-z0-9+/=]+)/)?.[1]
          assert.ok(local, 'The compatible local Python invocation did not finish')
          temporaryDetails = JSON.parse(Buffer.from(local, 'base64').toString('utf8'))
          const ready = result.output.match(/PLUGIN_READY_PYTHON_RESULT:([A-Za-z0-9+/=]+)/)?.[1]
          assert.ok(
            ready,
            'The plugin did not switch to ready managed Python on its next invocation'
          )
          const readyDetails = JSON.parse(Buffer.from(ready, 'base64').toString('utf8'))
          assert.equal(readyDetails.executable, details.executable)
          assert.equal(readyDetails.no_site, 0)
          events = [assistantMessage(COMPLETE)]
        } else {
          assert.equal(started, false, 'The chat must start the plugin command only once')
          started = true
          events = shellCommandResponse(body, CALL, command, workspacePath)
        }
      }
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },
    async start(control) {
      await control.command('navigate', 'body', { value: '/' })
      await createSingleRootLocalProject(control, workspacePath, 'python-plugin-chat', uiTimeoutMs)
      await selectE2EModel(control)
      active = true
      await control.command(
        'fill',
        `${PANE} [data-testid="chat-message-input"][contenteditable="true"]`,
        {
          value: `${PROMPT}: Use the plugin skill at ${join(plugin, 'skills', 'example', 'SKILL.md')} to inspect its Python runtime.`,
        }
      )
      await control.command('clickWhenEnabled', `${PANE} [data-testid="send-message-button"]`, {
        timeoutMs: uiTimeoutMs,
      })
    },
    async verify(control) {
      await control.command('waitFor', `${PANE} [data-testid="message-assistant"]`, {
        text: COMPLETE,
        timeoutMs: PYTHON_BOOTSTRAP_TIMEOUT_MS,
      })
      assert.equal(details.version, '3.12.12')
      assert.match(temporaryDetails.version, /^3\.12\./)
      assert.equal(temporaryDetails.no_site, 1)
      assert.equal(temporaryDetails.pythonhome, null)
      assert.equal(temporaryDetails.pythonpath, null)
      assert.equal(temporaryDetails.bridge_token, false)
      assert.notEqual(temporaryDetails.executable, details.executable)
      for (const root of [plugin, localPlugin]) {
        await assert.rejects(
          access(join(root, 'skills', 'example', 'scripts', '__pycache__')),
          { code: 'ENOENT' },
          'Interpreter selection must not write bytecode into the plugin package'
        )
      }
      assert.deepEqual(details.args, ['argument with spaces', '中文'])
      assertManagedPythonHome(details, electronUserDataDirectory)
      assert.equal(details.pythonpath, null)
      assert.equal(details.bridge_token, false)
      assert.equal(details.cwd, workspacePath)
      const executable = relative(electronUserDataDirectory, details.executable)
      assert.ok(executable && !executable.startsWith('..') && !isAbsolute(executable))
      await writeFile(
        join(resultDir, 'plugin-python-chat.json'),
        JSON.stringify({ managed: details, temporary: temporaryDetails }, null, 2)
      )
    },
  }
}
