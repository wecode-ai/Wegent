import assert from 'node:assert/strict'
import { exec, execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { promisify } from 'node:util'
import {
  WORKBENCH_APP_TASK_ID,
  WORKBENCH_APP_TASK_PROMPT,
  createWorkbenchAppTaskFixture,
  workbenchAppTaskCommand,
  readWorkbenchAppTaskResult,
} from '../e2e/desktop/modules/workbench-app-task-fixture.mjs'

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)

test('HTTP routing recognizes the quoted task prompt as user text and preserves real login execution', async () => {
  const workspacePath = tmpdir()
  const fixture = createWorkbenchAppTaskFixture({
    workspacePath,
    electronUserDataDirectory: tmpdir(),
    uiTimeoutMs: 1000,
  })
  const activated = new Error('Task submitted; stop before installation review')
  await assert.rejects(
    fixture.verify(
      {
        async command(action, selector) {
          if (action === 'snapshot')
            return JSON.stringify({ testIds: ['runtime-project-sortable-list'] })
          if (action === 'getValue') return workspacePath
          if (action === 'getText')
            return selector.includes('model-selector-button') ? 'GPT 5.6 Luna' : ''
          if (action === 'getAttribute') return 'wework-e2e'
          if (action === 'getWorkbenchDebugSnapshot')
            return JSON.stringify({
              workbench: { currentProject: { name: 'workbench-app-task-e2e' } },
            })
          return ''
        },
      },
      {
        reviewInstallation: async () => {
          throw activated
        },
      }
    ),
    error => error === activated
  )
  assert.equal(fixture.diagnostics().active, true)
  const body = {
    input: [{ role: 'user', content: [{ type: 'input_text', text: WORKBENCH_APP_TASK_PROMPT }] }],
    tools: [{ type: 'function', name: 'exec_command' }],
  }
  assert.equal(JSON.stringify(body).includes(WORKBENCH_APP_TASK_PROMPT), false)
  const route = async input => {
    const request = Readable.from([JSON.stringify({ ...body, input })])
    request.method = 'POST'
    const response = {
      status: null,
      output: '',
      writeHead(status) {
        this.status = status
      },
      end(output) {
        this.output = output
      },
    }
    return {
      handled: await fixture.handleHttp(request, response, new URL('http://fixture/v1/responses')),
      response,
    }
  }
  assert.equal(
    (await route([{ role: 'developer', content: WORKBENCH_APP_TASK_PROMPT }])).handled,
    false
  )
  assert.equal(fixture.diagnostics().requested, false)
  const { handled, response } = await route(body.input)
  assert.equal(handled, true)
  assert.equal(response.status, 200)
  const events = response.output
    .split('\n')
    .filter(line => line.startsWith('data: '))
    .map(line => JSON.parse(line.slice(6)))
  const call = events.find(event => event.type === 'response.output_item.done').item
  assert.equal(call.name, 'exec_command')
  const options = JSON.parse(call.arguments)
  assert.equal(options.login, true)
  assert.equal(options.workdir, workspacePath)
  assert.equal(
    options.cmd,
    workbenchAppTaskCommand(join(workspacePath, 'task calculator'), tmpdir())
  )
})

test('task setup returns from Applications to the mounted workbench before opening its project picker', async () => {
  const steps = []
  const reachedProjectSetup = new Error('Reached the shared project setup')
  const fixture = createWorkbenchAppTaskFixture({
    workspacePath: tmpdir(),
    electronUserDataDirectory: tmpdir(),
    uiTimeoutMs: 1000,
  })
  const control = {
    command: async (action, selector, options) => {
      steps.push({ action, selector, options })
      if (action === 'snapshot') throw reachedProjectSetup
    },
  }
  await assert.rejects(fixture.verify(control, {}), error => error === reachedProjectSetup)
  assert.deepEqual(
    steps.slice(0, 3).map(step => step.action),
    ['navigate', 'waitFor', 'waitFor']
  )
  assert.deepEqual(steps[0], { action: 'navigate', selector: 'body', options: { value: '/' } })
  assert.match(steps[1].selector, /desktop-workbench-main/)
  assert.equal(steps[1].options.visible, true)
  assert.match(steps[2].selector, /chat-message-input/)
  assert.equal(steps[2].options.visible, true)
  assert.equal(steps[3].action, 'snapshot')
})

// This protocol test exercises the fixture's subprocess and success guards.
// The desktop checkpoint runs the production launcher and Host instead.
async function fixture(
  t,
  { rejectInstall = false, rejectVerification = false, verificationStatus = 'passed' } = {}
) {
  const directory = await mkdtemp(join(tmpdir(), 'light-app-task-protocol-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const bin = join(directory, 'runtime', 'wework-cli-bin')
  await mkdir(bin, { recursive: true })
  const projectPath = join(directory, "workspace's custom calculator")
  const statePath = join(directory, 'protocol-state.json')
  const script = join(bin, 'protocol-cli.cjs')
  await writeFile(
    script,
    `#!/usr/bin/env node
const fs = require('node:fs'), assert = require('node:assert/strict');
const args = process.argv.slice(2);
const action = args[1];
assert.equal(args[0], action === 'verify' ? 'smart-app' : 'workbench');
const statePath = ${JSON.stringify(statePath)};
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { actions: [] };
state.actions.push(args);
fs.writeFileSync(statePath, JSON.stringify(state));
if (${JSON.stringify(rejectVerification)} && action === 'verify') {
  console.error('Smart app project is not a linked project root');
  process.exit(1);
}
if (${JSON.stringify(rejectInstall)} && action === 'install') {
  console.error('Expected a path or desktop subcommand: ' + args.join(' '));
  process.exit(1);
}
if (action === 'create') {
  const project = args[args.indexOf('--project') + 1];
  assert.equal(project, ${JSON.stringify(projectPath)});
  assert.equal(args[args.indexOf('--flavor') + 1], 'lightweight');
  fs.mkdirSync(require('node:path').join(project, 'scripts'), {recursive:true});
  fs.writeFileSync(require('node:path').join(project, 'scripts/build.mjs'), "import { writeFile } from 'node:fs/promises'; await writeFile(new URL('../build-complete', import.meta.url), '')");
  fs.writeFileSync(require('node:path').join(project, 'plugin-manifest.json'), JSON.stringify({ name:${JSON.stringify(WORKBENCH_APP_TASK_ID)}, displayName:'Task calculator', flavor:'lightweight' }));
  state.created = { projectPath:project };
} else if (action === 'verify') {
  const project = args[args.indexOf('--project') + 1];
  assert.equal(project, ${JSON.stringify(projectPath)});
  assert.equal(state.app, undefined, 'Source verification must precede installation');
  assert.ok(fs.existsSync(require('node:path').join(project, 'build-complete')), 'The fixture verified before building source');
  state.verification = { status: ${JSON.stringify(verificationStatus)}, projectRoot: fs.realpathSync(project) };
} else if (action === 'install') {
  assert.equal(state.verification?.status, 'passed', 'The fixture installed unverified source');
  const project = args[args.indexOf('--project') + 1];
  assert.equal(project, ${JSON.stringify(projectPath)});
  assert.ok(fs.readFileSync(require('node:path').join(project, 'view.html'), 'utf8').includes('Task calculator'));
  state.app = { id:'host-owned-installation', manifest: JSON.parse(fs.readFileSync(require('node:path').join(project, 'plugin-manifest.json'), 'utf8')), state:'running', visible:true };
} else {
  assert.ok(state.app, 'The fixture launched before installation');
  if (action === 'stop') { state.app.state = 'installed'; state.app.visible = false; }
  else if (action === 'launch') { state.app.state = 'running'; state.app.visible = true; }
  else assert.equal(action, 'list');
}
fs.writeFileSync(statePath, JSON.stringify(state));
console.log(JSON.stringify(action === 'create' ? state.created : action === 'verify' ? state.verification : action === 'list' ? [state.app] : state.app));
`
  )
  await chmod(script, 0o755)
  if (process.platform === 'win32') {
    await writeFile(join(bin, 'wework.cmd'), `@"${process.execPath}" "${script}" %*\r\n`)
  } else {
    await writeFile(
      join(bin, 'wework'),
      `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${script.replaceAll("'", "'\\''")}' "$@"\n`
    )
    await chmod(join(bin, 'wework'), 0o755)
  }
  return {
    context: { projectPath, electronUserDataDirectory: directory },
    statePath,
    run: (environment = {}) =>
      execAsync(workbenchAppTaskCommand(projectPath, directory), {
        env: {
          ...process.env,
          WEWORK_CLI_PATH: join(bin, process.platform === 'win32' ? 'wework.cmd' : 'wework'),
          ...environment,
        },
        timeout: 10_000,
      }),
  }
}

test('login startup shadows PATH while the Host-injected launcher verifies, installs, stops, and launches a custom package', async t => {
  const { run, context, statePath } = await fixture(t)
  const { stdout } = await run()
  const result = readWorkbenchAppTaskResult(stdout, context)
  assert.equal(result.verification.status, 'passed')
  assert.equal(result.verification.projectRoot, await realpath(context.projectPath))
  assert.equal(result.installed.manifest.name, WORKBENCH_APP_TASK_ID)
  assert.equal(result.installed.id, 'host-owned-installation')
  assert.notEqual(result.resolvedLauncher, result.launcher)
  assert.match(result.resolvedLauncher, /shadow-bin[/\\]wework(?:\.cmd)?$/)
  assert.equal(result.shadowInvoked, false)
  await assert.rejects(
    readFile(join(`${context.projectPath}.cli-login-fixture`, 'old-wrapper-invoked')),
    { code: 'ENOENT' }
  )
  if (process.platform !== 'win32') {
    const profile = join(
      `${context.projectPath}.cli-login-fixture`,
      process.platform === 'darwin' ? '.zprofile' : 'login-profile.sh'
    )
    const content = await readFile(profile, 'utf8')
    assert.match(content, /export PATH=/)
    assert.doesNotMatch(content, /WEWORK_CLI_PATH/)
  }
  const state = JSON.parse(await readFile(statePath, 'utf8'))
  assert.deepEqual(
    state.actions.map(args => args.slice(0, 2)),
    [
      ['workbench', 'create'],
      ['smart-app', 'verify'],
      ['workbench', 'install'],
      ['workbench', 'stop'],
      ['workbench', 'list'],
      ['workbench', 'launch'],
    ]
  )
  assert.ok(state.actions.every(args => args.includes('--format') && args.includes('json')))
  assert.equal(
    await readFile(join(context.projectPath, 'app.js'), 'utf8').then(text =>
      text.includes('window.weworkWorkbench.storage.set({ sum })')
    ),
    true
  )
})

test('a task without the Host-provided absolute CLI path fails before invoking a launcher', async t => {
  const { run, statePath } = await fixture(t)
  await assert.rejects(run({ WEWORK_CLI_PATH: undefined }), error => {
    assert.match(error.stderr, /did not inherit an absolute WEWORK_CLI_PATH/)
    assert.doesNotMatch(error.stdout, /WEWORK_WORKBENCH_APP_TASK_RESULT:/)
    return true
  })
  await assert.rejects(readFile(statePath), { code: 'ENOENT' })
})

test('the old bare command is rejected by the same task-owned login PATH shadow', async t => {
  const { run, context } = await fixture(t)
  await run()
  const directory = `${context.projectPath}.cli-login-fixture`
  let bareCommand
  if (process.platform === 'win32') {
    bareCommand = execAsync('wework workbench --help', {
      env: { ...process.env, PATH: `${join(directory, 'shadow-bin')};${process.env.PATH}` },
    })
  } else {
    const darwin = process.platform === 'darwin'
    const profile = join(directory, 'login-profile.sh').replaceAll("'", "'\\''")
    bareCommand = execFileAsync(
      darwin ? '/bin/zsh' : '/bin/bash',
      darwin
        ? ['-lc', 'wework workbench --help']
        : ['--noprofile', '--norc', '-lc', `. '${profile}'; wework workbench --help`],
      { ...(darwin ? { env: { ...process.env, ZDOTDIR: directory } } : {}) }
    )
  }
  await assert.rejects(bareCommand, error => {
    assert.equal(error.code, 97)
    assert.match(error.stderr, /Stale desktop-only Wework launcher must not be called/)
    return true
  })
  assert.match(await readFile(join(directory, 'old-wrapper-invoked'), 'utf8'), /invoked/)
})

test('a source verification CLI failure stops the task before installation', async t => {
  const { run, statePath } = await fixture(t, { rejectVerification: true })
  await assert.rejects(run(), error => {
    assert.notEqual(error.code, 0)
    assert.match(error.stderr, /Smart app project is not a linked project root/)
    assert.doesNotMatch(error.stdout, /WEWORK_WORKBENCH_APP_TASK_RESULT:/)
    return true
  })
  const state = JSON.parse(await readFile(statePath, 'utf8'))
  assert.deepEqual(
    state.actions.map(args => args.slice(0, 2)),
    [
      ['workbench', 'create'],
      ['smart-app', 'verify'],
    ]
  )
  assert.equal(state.app, undefined)
})

for (const verificationStatus of ['failed', 'stale']) {
  test(`a ${verificationStatus} verification report stops the task before installation`, async t => {
    const { run, statePath } = await fixture(t, { verificationStatus })
    await assert.rejects(run(), error => {
      assert.match(error.stderr, /The custom source did not pass verification/)
      assert.doesNotMatch(error.stdout, /WEWORK_WORKBENCH_APP_TASK_RESULT:/)
      return true
    })
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    assert.deepEqual(
      state.actions.map(args => args.slice(0, 2)),
      [
        ['workbench', 'create'],
        ['smart-app', 'verify'],
      ]
    )
    assert.equal(state.app, undefined)
  })
}

test('a rejected installation cannot produce a success marker by echoing the requested path', async t => {
  const { run, context } = await fixture(t, { rejectInstall: true })
  await assert.rejects(run(), error => {
    assert.notEqual(error.code, 0)
    assert.match(error.stderr, /Expected a path or desktop subcommand/)
    assert.doesNotMatch(error.stdout, /WEWORK_WORKBENCH_APP_TASK_RESULT:/)
    assert.throws(
      () => readWorkbenchAppTaskResult(error.stderr, context),
      /real task's workbench CLI failed/
    )
    return true
  })
})

test('result validation rejects missing markers, unverified source, wrong IDs, unrelated launchers, and failed window states', async t => {
  const projectPath = await mkdtemp(join(tmpdir(), 'calculator-result-'))
  t.after(() => rm(projectPath, { recursive: true, force: true }))
  const context = { projectPath, electronUserDataDirectory: tmpdir() }
  const record = {
    id: 'owned-calculator',
    manifest: {
      name: WORKBENCH_APP_TASK_ID,
      displayName: 'Task calculator',
      flavor: 'lightweight',
    },
  }
  const valid = {
    launcher: join(
      tmpdir(),
      'runtime',
      'wework-cli-bin',
      process.platform === 'win32' ? 'wework.cmd' : 'wework'
    ),
    resolvedLauncher: join(
      `${context.projectPath}.cli-login-fixture`,
      'shadow-bin',
      process.platform === 'win32' ? 'wework.cmd' : 'wework'
    ),
    shadowInvoked: false,
    loginShell:
      process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'zsh' : 'bash',
    projectPath: context.projectPath,
    verification: { status: 'passed', projectRoot: await realpath(projectPath) },
    installed: record,
    stopped: { ...record, state: 'installed' },
    launched: { ...record, state: 'running', visible: true },
  }
  const output = result =>
    `WEWORK_WORKBENCH_APP_TASK_RESULT:${Buffer.from(JSON.stringify(result)).toString('base64')}`
  assert.deepEqual(readWorkbenchAppTaskResult(output(valid), context), valid)
  assert.throws(
    () => readWorkbenchAppTaskResult('wework workbench install --project calculator', context),
    /real task's workbench CLI failed/
  )
  assert.throws(() =>
    readWorkbenchAppTaskResult(output({ ...valid, verification: undefined }), context)
  )
  assert.throws(() =>
    readWorkbenchAppTaskResult(
      output({ ...valid, verification: { ...valid.verification, status: 'failed' } }),
      context
    )
  )
  assert.throws(() =>
    readWorkbenchAppTaskResult(
      output({
        ...valid,
        verification: { ...valid.verification, projectRoot: join(tmpdir(), 'other-project') },
      }),
      context
    )
  )
  assert.throws(() =>
    readWorkbenchAppTaskResult(
      output({
        ...valid,
        installed: { ...record, manifest: { ...record.manifest, name: 'wrong-app' } },
      }),
      context
    )
  )
  assert.throws(() =>
    readWorkbenchAppTaskResult(
      output({ ...valid, launched: { ...valid.launched, id: 'wrong-app' } }),
      context
    )
  )
  assert.throws(() =>
    readWorkbenchAppTaskResult(output({ ...valid, launcher: join(tmpdir(), 'wework') }), context)
  )
  assert.throws(() =>
    readWorkbenchAppTaskResult(output({ ...valid, resolvedLauncher: valid.launcher }), context)
  )
  assert.throws(() =>
    readWorkbenchAppTaskResult(output({ ...valid, shadowInvoked: true }), context)
  )
  assert.throws(() =>
    readWorkbenchAppTaskResult(
      output({ ...valid, launched: { ...valid.launched, state: 'installed' } }),
      context
    )
  )
  assert.throws(() =>
    readWorkbenchAppTaskResult(
      output({ ...valid, launched: { ...valid.launched, visible: false } }),
      context
    )
  )
})
