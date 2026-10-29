import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
export const PYTHON_BOOTSTRAP_TIMEOUT_MS = 13 * 60_000
export const MANAGED_PYTHON_VERSION = '3.12.12'

export function managedPythonPath(userDataDirectory) {
  return join(
    userDataDirectory,
    'runtime',
    'bin',
    process.platform === 'win32' ? 'python.exe' : 'python3'
  )
}

export async function assertPathMissing(path, message) {
  await assert.rejects(access(path), { code: 'ENOENT' }, message)
}

export async function inspectManagedPython(userDataDirectory, cwd) {
  const { stdout } = await run(
    managedPythonPath(userDataDirectory),
    [
      '-I',
      '-c',
      'import ensurepip, json, ssl, sys, venv, zlib; print(json.dumps({"version": sys.version.split()[0], "executable": sys.executable, "prefix": sys.base_prefix, "ssl": ssl.OPENSSL_VERSION}))',
    ],
    { cwd, timeout: 5_000 }
  )
  const details = JSON.parse(stdout)
  assert.equal(details.version, MANAGED_PYTHON_VERSION)
  const prefix = relative(
    join(userDataDirectory, 'managed-runtimes', 'python', 'installations'),
    details.prefix
  )
  assert.ok(
    prefix && !prefix.startsWith('..') && !isAbsolute(prefix),
    'Python used a system installation'
  )
  // uv uses a trampoline on Windows and a symlink on Unix. CPython may report
  // the real executable rather than the bin launcher, but it must belong here.
  const executable = relative(userDataDirectory, details.executable)
  assert.ok(
    executable && !executable.startsWith('..') && !isAbsolute(executable),
    'Python ran outside this desktop instance'
  )
  return details
}

export async function waitForPythonRuntimeEvent(
  logPath,
  event,
  startOffset = 0,
  deadline = Date.now() + PYTHON_BOOTSTRAP_TIMEOUT_MS
) {
  while (Date.now() < deadline) {
    const log = (await readFile(logPath, 'utf8')).slice(startOffset)
    if (event === 'python-runtime-install-completed') {
      const failure = [
        'python-runtime-install-failed',
        'python-runtime-background-ensure-failed',
      ].find(candidate => log.includes(candidate))
      if (failure) {
        throw new Error(`The real Python installation reported ${failure}; see ${logPath}`)
      }
    }
    if (log.includes(event)) return log
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`The real Python runtime did not report ${event}; see ${logPath}`)
}

export async function collectManagedPythonStatus(control, windowLabel = 'main') {
  const diagnostic = { capturedAt: new Date().toISOString(), windowLabel }
  try {
    await control.commandForWindow(windowLabel, 'navigate', 'body', {
      value: '/settings/execution-environments',
    })
    await control.commandForWindow(
      windowLabel,
      'waitFor',
      '[data-testid="execution-environment-python-status"]'
    )
    diagnostic.statusText = await control.commandForWindow(
      windowLabel,
      'getText',
      '[data-testid="execution-environment-python-status"]'
    )
  } catch {
    diagnostic.captureError = true
  }
  return diagnostic
}

export async function assertManagedPythonStartup(
  control,
  { userDataDirectory, windowLabel = 'main', logPath, diagnosticPath }
) {
  const deadline = Date.now() + PYTHON_BOOTSTRAP_TIMEOUT_MS
  try {
    await waitForPythonRuntimeEvent(logPath, 'python-runtime-install-completed', 0, deadline)
    await assertManagedPythonSettings(control, userDataDirectory, windowLabel, deadline)
  } catch (error) {
    try {
      const diagnostic = await collectManagedPythonStatus(control, windowLabel)
      await writeFile(diagnosticPath, JSON.stringify(diagnostic, null, 2))
    } catch {
      console.error('[desktop-e2e] Python startup diagnostic collection failed')
    }
    throw error
  }
}

export async function assertManagedPythonSettings(
  control,
  userDataDirectory,
  windowLabel = 'main',
  deadline
) {
  await control.commandForWindow(windowLabel, 'navigate', 'body', {
    value: '/settings/execution-environments',
  })
  const timeoutMs = deadline === undefined ? PYTHON_BOOTSTRAP_TIMEOUT_MS : deadline - Date.now()
  assert.ok(timeoutMs > 0, 'The managed Python readiness deadline expired before checking settings')
  await control.commandForWindow(
    windowLabel,
    'waitFor',
    '[data-testid="execution-environment-python"]',
    {
      text: `已安装 · Wework 管理 · ${MANAGED_PYTHON_VERSION}`,
      timeoutMs,
    }
  )
  const text = await control.commandForWindow(
    windowLabel,
    'getText',
    '[data-testid="execution-environment-python"]'
  )
  assert.ok(
    text.includes(managedPythonPath(userDataDirectory)),
    'The runtime UI advertised another instance Python'
  )
}
