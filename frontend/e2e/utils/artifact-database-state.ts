// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from 'node:child_process'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const repository = resolve(__dirname, '../../..')

export async function artifactDatabaseState(data: {
  operation: 'inspect' | 'rebind'
  task_id: number
  context_id: number
  user_id: number
  expected_device_id: string
  replacement_device_id?: string
}): Promise<{
  executor_name: string
  source: { executor_name: string }
  binary_size: number
  image_base64: string
  extracted_text: string
}> {
  if (!process.env.DATABASE_URL)
    throw new Error('Artifact E2E requires the isolated service DATABASE_URL')
  // CI mounts the running Backend's checkout into a different Python runtime.
  // Never sync its service .venv or rewrite the lockfile from this helper.
  const result = await execFileAsync(
    'uv',
    [
      'run',
      '--isolated',
      '--frozen',
      '--no-editable',
      '--no-env-file',
      'python',
      join(repository, 'backend/tests/e2e/artifact_task_state.py'),
    ],
    {
      cwd: join(repository, 'backend'),
      env: {
        ...process.env,
        UV_NO_SYNC: '0',
        WEGENT_ARTIFACT_E2E_REQUEST: JSON.stringify(data),
      },
    }
  )
  return JSON.parse(result.stdout)
}
