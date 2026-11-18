import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createCloudConfigModelService } from '../e2e/desktop/modules/cloud-config-model-service.mjs'
import {
  cloudConfigNativeArguments,
  cloudConfigNativeLauncher,
} from '../e2e/desktop/modules/cloud-config-native-process.mjs'
import { wrapWindowsScriptCommand } from './child-process-command.mjs'

test('every loader observes the same bundle outage until the model service recovers', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cloud-config-service-'))
  const codexHome = join(root, 'managed')
  const model = createCloudConfigModelService()
  t.after(async () => {
    await model.close()
    await rm(root, { recursive: true, force: true })
  })
  await mkdir(codexHome)
  await writeFile(join(codexHome, 'config.toml'), '')
  const appEnvironment = { HOME: join(root, 'home'), CODEX_BINARY_PATH: process.execPath }
  await model.prepareApp({ appEnvironment, codexHome, control: { url: 'http://127.0.0.1:1' } })
  const config = await readFile(join(codexHome, 'config.toml'), 'utf8')
  const baseUrl = config.match(/chatgpt_base_url = "([^"]+)"/)[1]
  const bundle = () => fetch(`${baseUrl}wham/config/bundle`)
  assert.equal((await bundle()).status, 200)
  assert.equal(await model.failBundle(), 0)
  for (const loader of ['background bootstrap', 'tested bootstrap', 'tested long-lived']) {
    const response = await bundle()
    assert.equal(response.status, 503, loader)
    assert.deepEqual(await response.json(), { error: 'Model subscription service unavailable' })
  }
  assert.equal(model.diagnostics().bundleFailures, 3)
  model.recoverBundle()
  assert.equal((await bundle()).status, 200)
  const command = wrapWindowsScriptCommand(appEnvironment.CODEX_BINARY_PATH, ['--version'])
  const result = await promisify(execFile)(command.command, command.args)
  assert.equal(result.stdout.trim(), process.version)
})

test('only app-server launches receive the isolated native subscription origin', () => {
  const baseUrl = 'http://127.0.0.1:4000/backend-api/'
  const args = ['-c', 'permissions.default="project"', 'app-server']
  assert.deepEqual(cloudConfigNativeArguments(baseUrl, args), [
    '-c',
    `chatgpt_base_url=${JSON.stringify(baseUrl)}`,
    ...args,
  ])
  assert.deepEqual(cloudConfigNativeArguments(baseUrl, ['--version']), ['--version'])
  assert.deepEqual(args, ['-c', 'permissions.default="project"', 'app-server'])
})

test('the native relay preserves protocol bytes and the actual child exit status', async () => {
  const relay = fileURLToPath(
    new URL('../e2e/desktop/modules/cloud-config-native-process.mjs', import.meta.url)
  )
  const script =
    'process.stdin.pipe(process.stdout); process.stdin.on("end", () => {' +
    'process.stderr.write("native-stderr"); process.exitCode = 7 })'
  const child = spawn(
    process.execPath,
    [relay, process.execPath, 'http://127.0.0.1:4000/backend-api/', '-e', script],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  )
  const input = '{"id":1,"method":"initialize","params":{"name":"native fixture"}}\n'
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', data => (stdout += data))
  child.stderr.on('data', data => (stderr += data))
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => resolve(code))
  })
  child.stdin.end(input)
  assert.equal(await exited, 7)
  assert.equal(stdout, input)
  assert.equal(stderr, 'native-stderr')
})

test('native launchers quote fixture paths and preserve the caller arguments on both hosts', () => {
  const options = { binary: '/fixture/a b/codex', baseUrl: 'http://127.0.0.1:4000/backend-api/' }
  const unix = cloudConfigNativeLauncher({ ...options, node: "/fixture/node's path" })
  assert.ok(unix.startsWith('#!/bin/sh\nexec '))
  assert.ok(unix.includes("'/fixture/node'\\''s path'"))
  assert.ok(unix.endsWith(' "$@"\n'))
  const windows = cloudConfigNativeLauncher({
    ...options,
    platform: 'win32',
    node: 'C:\\fixture 100%\\node.exe',
  })
  assert.ok(windows.includes('"C:\\fixture 100%%\\node.exe"'))
  assert.ok(windows.endsWith(' %*\r\n'))
})
