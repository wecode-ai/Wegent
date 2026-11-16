// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from 'node:child_process'
import { delimiter, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const repository = resolve(__dirname, '../../..')

type IsolatedDatabaseRequest = Record<string, unknown>

export async function runIsolatedDatabasePython(
  script: string,
  request?: IsolatedDatabaseRequest,
  timeout = 30_000,
  argument?: string
): Promise<string> {
  if (!process.env.DATABASE_URL) {
    throw new Error('Isolated database E2E requires the isolated service DATABASE_URL')
  }
  // CI mounts the running Backend's checkout into a different Python runtime.
  // An isolated environment avoids its incompatible virtualenv while editable
  // sources keep browser-container tests on the checked-out Backend code.
  const result = await execFileAsync(
    'uv',
    [
      'run',
      '--isolated',
      '--frozen',
      '--no-env-file',
      'python',
      script,
      ...(argument ? [argument] : []),
    ],
    {
      cwd: join(repository, 'backend'),
      timeout,
      env: {
        ...process.env,
        UV_NO_SYNC: '0',
        UV_NO_EDITABLE: '0',
        PYTHONPATH: [join(repository, 'backend'), repository, process.env.PYTHONPATH]
          .filter(Boolean)
          .join(delimiter),
        ...(request ? { WEGENT_ISOLATED_DATABASE_REQUEST: JSON.stringify(request) } : {}),
      },
    }
  )
  return result.stdout
}

export async function prepareIsolatedDatabaseState(): Promise<void> {
  // Building the isolated environment can exceed the default fixture timeout.
  await runIsolatedDatabasePython(
    '-c',
    undefined,
    300_000,
    'from app.db.session import SessionLocal'
  )
}

export async function removeExecutorSessionProof(input: {
  task_id: number
  user_id: number
}): Promise<{ removed: number; sessions: Array<Record<string, unknown>> }> {
  const output = await runIsolatedDatabasePython(
    'tests/e2e_remove_executor_session.py',
    input,
    30_000
  )
  return JSON.parse(output)
}

export async function inspectExecutorSessionProof(input: {
  task_id: number
  user_id: number
}): Promise<{ sessions: Array<Record<string, unknown>> }> {
  const output = await runIsolatedDatabasePython(
    'tests/e2e_remove_executor_session.py',
    { ...input, operation: 'inspect' },
    30_000
  )
  return JSON.parse(output)
}
