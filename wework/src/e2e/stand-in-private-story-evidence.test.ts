// @vitest-environment node

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { readStoryTaskEvidence } from '../../e2e/desktop/modules/stand-in-private-story-evidence.mjs'

test('private fixture evidence retains exact completion scope without exposing execution profiles', async () => {
  const home = await mkdtemp(join(tmpdir(), 'stand-in-story-evidence-'))
  const source = { providerId: 'third-party', profile: 'account', kind: 'inbox', id: 'selected' }
  try {
    await mkdir(join(home, 'runtime-work'))
    await writeFile(
      join(home, 'runtime-work/index.json'),
      JSON.stringify({
        tasks: {
          child: {
            local_task_id: 'child',
            thread_id: 'thread',
            workspace_path: 'PRIVATE_CANARY',
            runtime_handle: {
              lastTurnId: 'turn',
              standInResultReceipt: 'exact-receipt',
              standInResult: {
                status: 'done',
                turnId: 'turn',
                private: 'PRIVATE_CANARY',
                generation: {
                  reportTo: { userId: 9, taskId: 'parent', private: 'PRIVATE_CANARY' },
                  delegation: { sourceTaskId: 'parent', private: 'PRIVATE_CANARY' },
                },
              },
              executionRequest: {
                model_config: { secret: 'PRIVATE_CANARY' },
                standInDelegation: {
                  private: 'PRIVATE_CANARY',
                  readSources: [{ ...source, token: 'PRIVATE_CANARY' }],
                },
              },
            },
          },
          other: { local_task_id: 'other', runtime_handle: { standInResultReceipt: 'foreign' } },
        },
      })
    )
    const evidence = await readStoryTaskEvidence(home, 'child')
    expect(evidence).toEqual({
      taskId: 'child',
      threadId: 'thread',
      lastTurnId: 'turn',
      receipt: 'exact-receipt',
      completion: {
        status: 'done',
        turnId: 'turn',
        generation: {
          reportTo: { userId: 9, taskId: 'parent' },
          delegation: { sourceTaskId: 'parent' },
        },
      },
      delegation: { readSources: [source] },
    })
    expect(JSON.stringify(evidence)).not.toContain('PRIVATE_CANARY')
    expect(await readStoryTaskEvidence(home, 'missing')).toBeNull()
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
