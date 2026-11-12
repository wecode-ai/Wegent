import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join, normalize } from 'node:path'
import { selectedToolCall } from './model-tool-calls.mjs'
import { modelRequestTexts } from './model-tool-output.mjs'
import {
  assistantMessage,
  codexRequestKind,
  createSse,
  handleEmptyReplyPrediction,
  readRequestBody,
  requestAdvertisesProgrammaticExec,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
  selectProgrammaticExec,
  selectTool,
  toolOutputText,
} from './response-protocol.mjs'
import { createSingleRootLocalProject, selectE2EModel } from './shared.mjs'
import { waitForRuntimePaneReadyToSend } from './streaming-text-fixture.mjs'

export const WORKBENCH_APP_TASK_ID = 'e2e-task-calculator'
export const WORKBENCH_APP_TASK_PROMPT =
  'WEWORK_WORKBENCH_APP_TASK: Create a lightweight DSH calculator, install and launch it using the Host-provided "$WEWORK_CLI_PATH" workbench commands.'
const COMPLETE = 'WEWORK_WORKBENCH_APP_TASK_COMPLETE'
const RESULT_MARKER = 'WEWORK_WORKBENCH_APP_TASK_RESULT:'
const CALL_ID = 'workbench-app-task-cli'
const PANE = '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const FILES = {
  'view.html': `<html><body><h1>Task calculator</h1>
<label>First number<input data-testid="calculator-left" type="number" value="2"></label>
<label>Second number<input data-testid="calculator-right" type="number" value="3"></label>
<button data-testid="calculator-add" disabled>Add</button>
<output data-testid="calculator-result"></output><p data-testid="calculator-ready"></p>
<button data-testid="calculator-blank">Replace with blank document</button>
<button data-testid="calculator-remote">Replace with remote document</button>
<button data-testid="calculator-redirect">Redirect document</button>
<output data-testid="calculator-security"></output>
<script src="app.js"></script></body></html>`,
  'app.js': `const find = name => document.querySelector('[data-testid="calculator-' + name + '"]');
window.weworkWorkbench.storage.get().then(() => {
  find('ready').textContent = 'SDK ready';
  find('add').disabled = false;
});
find('add').addEventListener('click', async () => {
  const sum = Number(find('left').value) + Number(find('right').value);
  await window.weworkWorkbench.storage.set({ sum });
  find('result').textContent = String(sum);
});
for (const attempt of ['blank', 'remote', 'redirect']) find(attempt).addEventListener('click', async () => {
  parent.postMessage({channel:'wework-workbench',id:999,method:'storage.set',params:{value:{compromised:true}}}, '*');
  const destination = attempt === 'blank' ? 'about:blank' : 'https://replacement.invalid/workbench';
  if (attempt === 'redirect') {
    const refresh = document.createElement('meta');
    refresh.httpEquiv = 'refresh'; refresh.content = '0;url=' + destination;
    document.head.appendChild(refresh);
  } else {
    location.assign(destination);
    if (attempt === 'blank') return;
  }
  const value = await window.weworkWorkbench.storage.get();
  find('security').textContent = attempt + ':' + value.sum;
});`,
}

// Serialized into the real task; its only environment override is the task-owned ZDOTDIR.
function runWorkbenchAppTask({ project, expectedLauncher, files, id, resultMarker }) {
  const fs = require('node:fs')
  const path = require('node:path')
  const cp = require('node:child_process')
  const assert = require('node:assert/strict')
  const launcher = process.env.WEWORK_CLI_PATH
  assert.ok(
    launcher && path.isAbsolute(launcher),
    'The real task did not inherit an absolute WEWORK_CLI_PATH'
  )
  const windows = process.platform === 'win32'
  const darwin = process.platform === 'darwin'
  const fixtureDirectory = `${project}.cli-login-fixture`
  const shadowDirectory = path.join(fixtureDirectory, 'shadow-bin')
  const shadowLauncher = path.join(shadowDirectory, windows ? 'wework.cmd' : 'wework')
  const shadowMarker = path.join(fixtureDirectory, 'old-wrapper-invoked')
  const resolutionPath = path.join(fixtureDirectory, 'command-resolution.txt')
  const quote = value =>
    windows ? `"${value.replaceAll('"', '""')}"` : `'${value.replaceAll("'", "'\\''")}'`
  fs.mkdirSync(shadowDirectory, { recursive: true })
  fs.writeFileSync(
    shadowLauncher,
    windows
      ? `@echo off\r\n>>${quote(shadowMarker)} echo invoked\r\necho Stale desktop-only Wework launcher must not be called 1>&2\r\nexit /b 97\r\n`
      : `#!/bin/sh\nprintf invoked > ${quote(shadowMarker)}\nprintf 'Stale desktop-only Wework launcher must not be called\\n' >&2\nexit 97\n`,
    { mode: 0o755 }
  )
  const profile = path.join(fixtureDirectory, darwin ? '.zprofile' : 'login-profile.sh')
  if (!windows)
    fs.writeFileSync(
      profile,
      `export PATH=${quote(shadowDirectory)}:"$PATH"\n${darwin ? 'rehash' : 'hash -r'}\n`
    )
  const loginShell = windows ? 'cmd' : darwin ? 'zsh' : 'bash'
  function invoke(name, namespace, args) {
    const outputPath = path.join(fixtureDirectory, `${name}.json`)
    const invocation = `${windows ? 'call "%WEWORK_CLI_PATH%"' : '"$WEWORK_CLI_PATH"'} ${[namespace, ...args, '--format', 'json'].map(quote).join(' ')} > ${quote(outputPath)}`
    if (windows) {
      const scriptPath = path.join(fixtureDirectory, 'shadow-path.cmd')
      fs.writeFileSync(
        scriptPath,
        [
          '@echo off',
          'setlocal',
          `set "PATH=${shadowDirectory};%PATH%"`,
          `where wework > ${quote(resolutionPath)}`,
          'if errorlevel 1 exit /b 1',
          `if /I not "%WEWORK_CLI_PATH%"==${quote(expectedLauncher)} exit /b 1`,
          invocation,
          'if errorlevel 1 exit /b 1',
        ].join('\r\n')
      )
      cp.execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', quote(scriptPath)], {
        encoding: 'utf8',
        timeout: 300_000,
        maxBuffer: 1024 * 1024,
        windowsVerbatimArguments: true,
      })
    } else {
      const script = [
        'set -eu',
        ...(darwin ? ['[[ -o login ]]'] : [`. ${quote(profile)}`, 'shopt -q login_shell']),
        `command -v wework > ${quote(resolutionPath)}`,
        `[ "$(command -v wework)" = ${quote(shadowLauncher)} ]`,
        `[ "$WEWORK_CLI_PATH" = ${quote(expectedLauncher)} ]`,
        invocation,
      ].join('\n')
      cp.execFileSync(
        darwin ? '/bin/zsh' : '/bin/bash',
        darwin ? ['-lc', script] : ['--noprofile', '--norc', '-lc', script],
        {
          ...(darwin ? { env: { ...process.env, ZDOTDIR: fixtureDirectory } } : {}),
          encoding: 'utf8',
          timeout: 300_000,
          maxBuffer: 1024 * 1024,
        }
      )
    }
    return JSON.parse(fs.readFileSync(outputPath, 'utf8'))
  }
  const created = invoke('created', 'workbench', [
    'create',
    '--project',
    project,
    '--name',
    id,
    '--display-name',
    'Task calculator',
    '--flavor',
    'lightweight',
  ])
  assert.equal(created.projectPath, project)
  for (const [name, content] of Object.entries(files))
    fs.writeFileSync(path.join(project, name), content)
  cp.execFileSync(process.execPath, ['scripts/build.mjs'], {
    cwd: project,
    stdio: 'inherit',
    timeout: 10_000,
  })
  const verification = invoke('verified', 'smart-app', ['verify', '--project', project])
  assert.equal(verification?.status, 'passed', 'The custom source did not pass verification')
  assert.equal(
    verification.projectRoot,
    fs.realpathSync(project),
    'The CLI verified a different project'
  )
  const installed = invoke('installed', 'workbench', ['install', '--project', project])
  assert.ok(installed?.id, 'The installation was cancelled or has no Host identity')
  assert.equal(installed.manifest.name, id, 'The CLI did not install the requested custom package')
  invoke('stop', 'workbench', ['stop', '--id', installed.id])
  const stopped = invoke('stopped', 'workbench', ['list']).find(app => app.id === installed.id)
  assert.equal(stopped?.state, 'installed', 'The CLI did not stop the custom app before launch')
  const launched = invoke('launched', 'workbench', ['launch', '--id', installed.id])
  assert.equal(launched?.id, installed.id)
  assert.equal(launched.state, 'running')
  assert.equal(launched.visible, true)
  const resolvedLauncher = fs.readFileSync(resolutionPath, 'utf8').trim().split(/\r?\n/)[0]
  assert.equal(
    windows ? path.normalize(resolvedLauncher).toLowerCase() : resolvedLauncher,
    windows ? path.normalize(shadowLauncher).toLowerCase() : shadowLauncher,
    'The task did not reproduce PATH shadowing'
  )
  assert.equal(
    fs.existsSync(shadowMarker),
    false,
    'A workbench command invoked the stale PATH wrapper'
  )
  process.stdout.write(
    resultMarker +
      Buffer.from(
        JSON.stringify({
          launcher,
          resolvedLauncher,
          shadowInvoked: false,
          loginShell,
          projectPath: project,
          verification,
          installed,
          stopped,
          launched,
        })
      ).toString('base64') +
      '\n'
  )
}

/** Exercise login-profile PATH shadowing while preserving the Host-injected CLI identity. */
export function workbenchAppTaskCommand(projectPath, electronUserDataDirectory) {
  const expectedLauncher = join(
    electronUserDataDirectory,
    'runtime',
    'wework-cli-bin',
    process.platform === 'win32' ? 'wework.cmd' : 'wework'
  )
  const script = `(${runWorkbenchAppTask.toString()})(${JSON.stringify({ project: projectPath, expectedLauncher, files: FILES, id: WORKBENCH_APP_TASK_ID, resultMarker: RESULT_MARKER })})`
  return `node -e "eval(Buffer.from('${Buffer.from(script).toString('base64')}','base64').toString('utf8'))"`
}

export function readWorkbenchAppTaskResult(output, { projectPath, electronUserDataDirectory }) {
  const match = output.match(/WEWORK_WORKBENCH_APP_TASK_RESULT:([A-Za-z0-9+/=]+)/)
  assert.ok(match, `The real task's workbench CLI failed: ${output.slice(-6000)}`)
  const result = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'))
  const expectedLauncher = join(
    electronUserDataDirectory,
    'runtime',
    'wework-cli-bin',
    process.platform === 'win32' ? 'wework.cmd' : 'wework'
  )
  const canonical = value => {
    const path = normalize(value)
    return process.platform === 'win32' ? path.toLowerCase() : path
  }
  assert.equal(canonical(result.launcher), canonical(expectedLauncher))
  assert.equal(
    canonical(result.resolvedLauncher),
    canonical(
      join(
        `${projectPath}.cli-login-fixture`,
        'shadow-bin',
        process.platform === 'win32' ? 'wework.cmd' : 'wework'
      )
    )
  )
  assert.equal(result.shadowInvoked, false)
  assert.equal(
    result.loginShell,
    process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'zsh' : 'bash'
  )
  assert.equal(result.projectPath, projectPath)
  assert.equal(result.verification?.status, 'passed')
  assert.equal(canonical(result.verification.projectRoot), canonical(realpathSync(projectPath)))
  assert.match(result.installed?.id ?? '', /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/)
  assert.equal(result.installed?.manifest?.name, WORKBENCH_APP_TASK_ID)
  assert.equal(result.installed.manifest.displayName, 'Task calculator')
  assert.equal(result.installed.manifest.flavor, 'lightweight')
  assert.equal(result.stopped?.id, result.installed.id)
  assert.equal(result.stopped.state, 'installed')
  assert.equal(result.launched?.id, result.installed.id)
  assert.equal(result.launched.state, 'running')
  assert.equal(result.launched.visible, true)
  return result
}

export function createWorkbenchAppTaskFixture({
  workspacePath,
  electronUserDataDirectory,
  uiTimeoutMs,
  workbenchReadyTimeoutMs,
}) {
  const projectPath = join(workspacePath, 'task calculator')
  let active = false
  let requested = false
  let pendingCallId = CALL_ID
  let pollCount = 0
  let evidence = null
  let lastOutput = null

  function execute(body) {
    const cmd = workbenchAppTaskCommand(projectPath, electronUserDataDirectory)
    const commandOptions = { cmd, workdir: workspacePath, login: true, yield_time_ms: 1000 }
    if (!requestAdvertisesProgrammaticExec(body))
      return selectedToolCall(CALL_ID, selectTool(body, 'exec_command', commandOptions))
    const input = `// @exec: {"yield_time_ms": 120000}
const capability = name => {
  const matches = ALL_TOOLS.filter(tool => tool.name === name || tool.name.endsWith('__' + name));
  if (matches.length !== 1) throw new Error('Missing or ambiguous real shell capability: ' + name);
  return tools[matches[0].name];
};
let result = await capability('exec_command')(${JSON.stringify(commandOptions)});
text(result.output);
while (result.session_id) {
  result = await capability('write_stdin')({ session_id: result.session_id, chars: '', yield_time_ms: 1000 });
  text(result.output);
}
if (result.exit_code !== 0) throw new Error('The workbench task command exited with code ' + result.exit_code);`
    return selectedToolCall(CALL_ID, { codeMode: selectProgrammaticExec(body, input) })
  }

  return {
    async handleHttp(request, response, url) {
      if (
        !active ||
        request.method !== 'POST' ||
        !['/responses', '/v1/responses'].includes(url.pathname)
      )
        return false
      const body = await readRequestBody(request)
      if (!modelRequestTexts(body, 'user').includes(WORKBENCH_APP_TASK_PROMPT)) return false
      if (handleEmptyReplyPrediction(body, response)) return true
      const id = `workbench-app-task-${Date.now()}`
      let events
      if (codexRequestKind(body) === 'prewarm') events = [assistantMessage('Ready')]
      else if (!requested) {
        requested = true
        events = execute(body)
      } else {
        assert.ok(
          requestContainsToolOutput(body, pendingCallId),
          'The local task omitted its real CLI tool result'
        )
        const output = toolOutputText(body, pendingCallId)
        lastOutput = output
        const session = output.match(
          /(?:Process running with session ID|session_id["']?\s*:)\s*(\d+)/
        )
        if (!output.includes(RESULT_MARKER) && session) {
          pendingCallId = `${CALL_ID}-poll-${++pollCount}`
          events = selectedToolCall(
            pendingCallId,
            selectTool(body, 'write_stdin', {
              session_id: Number(session[1]),
              chars: '',
              yield_time_ms: 1000,
            })
          )
        } else {
          evidence = readWorkbenchAppTaskResult(output, { projectPath, electronUserDataDirectory })
          events = [assistantMessage(COMPLETE)]
        }
      }
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },

    diagnostics: () => ({ active, requested, pendingCallId, evidence, lastOutput }),

    async verify(control, { reviewInstallation, until }) {
      await control.command('navigate', 'body', { value: '/' })
      await control.command('waitFor', PANE, { visible: true })
      await control.command(
        'waitFor',
        `${PANE} [data-testid="chat-message-input"][contenteditable="true"]`,
        { visible: true }
      )
      await createSingleRootLocalProject(
        control,
        workspacePath,
        'workbench-app-task-e2e',
        uiTimeoutMs
      )
      await selectE2EModel(control)
      active = true
      await control.command(
        'fill',
        `${PANE} [data-testid="chat-message-input"][contenteditable="true"]`,
        {
          value: WORKBENCH_APP_TASK_PROMPT,
        }
      )
      await control.command('clickWhenEnabled', `${PANE} [data-testid="send-message-button"]`)
      await reviewInstallation('accept')
      await control.command('waitFor', `${PANE} [data-testid="message-assistant"]`, {
        text: COMPLETE,
        timeoutMs: workbenchReadyTimeoutMs,
      })
      assert.ok(requested && evidence, 'The real task did not complete the installed CLI path')
      await waitForRuntimePaneReadyToSend(control, uiTimeoutMs)
      const workbenchApp = async (action, options = {}) =>
        JSON.parse(
          await control.command('workbenchApp', 'body', {
            value: JSON.stringify({ action, id: evidence.installed.id, ...options }),
          })
        )
      await until(
        () => workbenchApp('snapshot'),
        value => value.running && value.visible && value.sdkAvailable,
        'The CLI did not launch the custom calculator with its SDK'
      )
      await until(
        () => workbenchApp('getText', { selector: '[data-testid="calculator-ready"]' }),
        value => value === 'SDK ready',
        'The custom calculator could not read SDK storage'
      )
      await workbenchApp('fill', { selector: '[data-testid="calculator-left"]', value: '2' })
      await workbenchApp('fill', { selector: '[data-testid="calculator-right"]', value: '3' })
      await workbenchApp('click', { selector: '[data-testid="calculator-add"]' })
      await until(
        () => workbenchApp('getText', { selector: '[data-testid="calculator-result"]' }),
        value => value === '5',
        'The task-created calculator did not compute 2 + 3'
      )
      const dataPath = join(
        electronUserDataDirectory,
        'harness-apps',
        'instances',
        evidence.installed.id,
        'wework-app.json'
      )
      const state = JSON.parse(await readFile(dataPath, 'utf8'))
      assert.deepEqual(state.state, { sum: 5 })
      await verifyWorkbenchDocumentAuthority({ workbenchApp, until, dataPath })
      await control.command('navigate', 'body', { value: '/sites?app_type=smart_app' })
      await control.command(
        'waitFor',
        `[data-testid="smart-app-created-item-${evidence.installed.id}"]`
      )
      await control.command(
        'clickWhenEnabled',
        `[data-testid="smart-app-actions-${evidence.installed.id}"]`
      )
      await control.command(
        'clickWhenEnabled',
        `[data-testid="smart-app-stop-menu-${evidence.installed.id}"]`
      )
      await until(
        () => workbenchApp('snapshot'),
        value => !value.running,
        'Stopping the replaced document did not stop its workbench'
      )
      assert.deepEqual(JSON.parse(await readFile(dataPath, 'utf8')).state, { sum: 5 })
      await control.command(
        'clickWhenEnabled',
        `[data-testid="harness-app-start-${evidence.installed.id}"]`
      )
      await until(
        () => workbenchApp('snapshot'),
        value => value.running && value.visible && value.sdkAvailable,
        'Explicitly restarting did not restore the original calculator with its SDK',
        workbenchReadyTimeoutMs
      )
      await until(
        () => workbenchApp('getText', { selector: '[data-testid="calculator-ready"]' }),
        value => value === 'SDK ready',
        'The restored calculator could not read its existing state'
      )
      assert.deepEqual((await workbenchApp('document')).state, { sum: 5 })
      await workbenchApp('click', { selector: '[data-testid="calculator-add"]' })
      await until(
        () => workbenchApp('getText', { selector: '[data-testid="calculator-result"]' }),
        value => value === '5',
        'The restored calculator could not use its new document connection'
      )
      assert.deepEqual(JSON.parse(await readFile(dataPath, 'utf8')).state, { sum: 5 })
      await control.command(
        'clickWhenEnabled',
        `[data-testid="smart-app-actions-${evidence.installed.id}"]`
      )
      await control.command(
        'clickWhenEnabled',
        `[data-testid="smart-app-remove-local-${evidence.installed.id}"]`
      )
      await control.command('waitFor', '[data-testid="smart-app-remove-local-confirm"]')
      await control.command('click', '[data-testid="smart-app-remove-local-confirm"]')
      await control.command('waitFor', '[data-testid="smart-apps-owned-page"]')
      await until(
        () => workbenchApp('snapshot'),
        value => !value.running,
        'Removing the task-created calculator left its window alive'
      )
      const registry = JSON.parse(
        await readFile(
          join(electronUserDataDirectory, 'harness-apps', 'installations.json'),
          'utf8'
        )
      )
      assert.equal(
        registry.some(app => app.id === evidence.installed.id),
        false
      )
      await assert.rejects(readFile(dataPath), { code: 'ENOENT' })
      await rm(projectPath, { recursive: true })
      await rm(`${projectPath}.cli-login-fixture`, { recursive: true })
      active = false
    },
  }
}

export async function verifyWorkbenchDocumentAuthority({ workbenchApp, until, dataPath }) {
  // Opaque origins and WindowProxy identity survive navigation; neither grants authority.
  for (const attempt of ['remote', 'redirect']) {
    const url = 'https://replacement.invalid/workbench'
    assert.deepEqual(
      await workbenchApp('clickAndWaitForBlockedNavigation', {
        selector: `[data-testid="calculator-${attempt}"]`,
        url,
      }),
      { clicked: true, blocked: true, url }
    )
    await until(
      () => workbenchApp('getText', { selector: '[data-testid="calculator-security"]' }),
      value => value === `${attempt}:5`,
      'The initial document lost its private SDK after blocked navigation'
    )
    assert.deepEqual((await workbenchApp('document')).state, { sum: 5 })
    assert.deepEqual(JSON.parse(await readFile(dataPath, 'utf8')).state, { sum: 5 })
  }
  // Chromium commits blank documents without a request throttle. They must receive no authority.
  assert.deepEqual(
    await workbenchApp('clickAndVerifyDocumentReplacement', {
      selector: '[data-testid="calculator-blank"]',
      url: 'about:blank',
    }),
    {
      clicked: true,
      replaced: true,
      url: 'about:blank',
      sdkAvailable: false,
      publicReplies: 0,
      privateReplies: 0,
    }
  )
  assert.deepEqual(JSON.parse(await readFile(dataPath, 'utf8')).state, { sum: 5 })
}
