// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from 'node:child_process'
import { delimiter, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const repository = resolve(__dirname, '../../..')

type ArtifactDatabaseRequest = {
  operation: 'inspect' | 'rebind'
  task_id: number
  context_id: number
  user_id: number
  expected_device_id: string
  replacement_device_id?: string
}
type ArtifactDatabaseResult = {
  executor_name: string
  source: { executor_name: string; workspace_root: string }
  binary_size: number
  image_base64: string
  extracted_text: string
}

async function runArtifactPython(args: string[], data?: ArtifactDatabaseRequest): Promise<string> {
  if (!process.env.DATABASE_URL)
    throw new Error('Artifact E2E requires the isolated service DATABASE_URL')
  // CI mounts the running Backend's checkout into a different Python runtime.
  // Isolate its .venv, but retain editable sources: wheel builds copy Python
  // files into shared/build and trigger the running service's source watcher.
  const result = await execFileAsync(
    'uv',
    ['run', '--isolated', '--frozen', '--no-env-file', 'python', ...args],
    {
      cwd: join(repository, 'backend'),
      timeout: data ? 30_000 : 300_000,
      env: {
        ...process.env,
        UV_NO_SYNC: '0',
        UV_NO_EDITABLE: '0',
        PYTHONPATH: [join(repository, 'backend'), repository, process.env.PYTHONPATH]
          .filter(Boolean)
          .join(delimiter),
        ...(data ? { WEGENT_ARTIFACT_E2E_REQUEST: JSON.stringify(data) } : {}),
      },
    }
  )
  return result.stdout
}

export async function prepareArtifactDatabaseState(): Promise<void> {
  // Download and build dependencies before starting a timed device turn.
  await runArtifactPython(['-c', 'from app.db.session import SessionLocal'])
}

export async function artifactDatabaseState(
  data: ArtifactDatabaseRequest
): Promise<ArtifactDatabaseResult> {
  return JSON.parse(
    await runArtifactPython([join(repository, 'backend/tests/e2e/artifact_task_state.py')], data)
  )
}
