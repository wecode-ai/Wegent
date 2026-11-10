import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { verifyRollbackProtection } from '../e2e/desktop/modules/rollback-protection.mjs'

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'wework-rollback-protection-'))
  const target = { version: '1.1.0', sha256: 'a'.repeat(64), name: 'target.tar.gz' }
  await writeFile(
    join(root, 'update-rollback-history.json'),
    JSON.stringify([
      {
        version: target.version,
        packageSha256: target.sha256,
        reason: 'rolled-back',
        token: 'activation',
        occurredAt: new Date().toISOString(),
      },
    ])
  )
  await writeFile(join(root, 'rolled-back-versions.json'), JSON.stringify([target.version]))
  try {
    await run({
      root,
      target,
      preparedTarget: { version: target.version, packageSha256: target.sha256 },
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

for (const confirmation of [false, true]) {
  test(`preserves real rollback files when the source ${confirmation ? 'requires confirmation' : 'blocks retry'}`, async () => {
    await fixture(async base => {
      const requests = []
      let cancelled = false
      let routed = false
      const result = await verifyRollbackProtection({
        ...base,
        requests,
        async route() {
          routed = true
        },
        async about() {
          assert.equal(routed, true)
        },
        control: {
          async command(name, selector) {
            if (name === 'getAppUpdateProgress')
              return JSON.stringify(
                confirmation
                  ? {
                      update: {
                        retryConfirmation: {
                          version: base.target.version,
                          token: 'b'.repeat(64),
                          reason: 'rolled-back',
                        },
                      },
                    }
                  : {}
              )
            if (name === 'getText')
              return confirmation
                ? base.target.version
                : '当前版本暂无已验证的升级路径，请稍后再检查。'
            if (name === 'getElementCount') return '1'
            if (name === 'click') {
              assert.equal(selector, '[data-testid="app-update-retry-cancel"]')
              cancelled = true
            }
            assert.notEqual(selector, '[data-testid="app-update-retry-confirm"]')
          },
        },
      })
      assert.equal(result.kind, confirmation ? 'confirmation-required' : 'blocked')
      assert.equal(cancelled, confirmation)
      assert.equal(result.packageSha256, base.target.sha256)
      assert.equal(requests.length, 0)
    })
  })
}

test('a download without consent cannot certify rollback protection', async () => {
  await fixture(async base => {
    const requests = []
    await assert.rejects(
      verifyRollbackProtection({
        ...base,
        requests,
        async route() {},
        async about() {},
        control: {
          async command(name) {
            if (name === 'getAppUpdateProgress') return '{}'
            if (name === 'getText') return 'No verified upgrade path'
            if (name === 'clickWhenEnabled') requests.push({ path: '/target.tar.gz' })
          },
        },
      }),
      /downloaded without consent/
    )
  })
})

test('historical slot descriptors and history omit the hash together without changing delivered identity', async () => {
  await fixture(async base => {
    const path = join(base.root, 'update-rollback-history.json')
    const history = JSON.parse(await readFile(path, 'utf8'))
    delete history[0].packageSha256
    await writeFile(path, JSON.stringify(history))
    const options = {
      ...base,
      preparedTarget: { version: base.target.version },
      requests: [],
      async route() {},
      async about() {},
      control: {
        async command(name) {
          if (name === 'getAppUpdateProgress') return '{}'
          if (name === 'getText') return 'No verified upgrade path'
        },
      },
    }
    assert.equal((await verifyRollbackProtection(options)).kind, 'blocked')
    await assert.rejects(
      verifyRollbackProtection({ ...options, preparedTarget: base.preparedTarget }),
      /package identity/
    )
    history[0].packageSha256 = 'c'.repeat(64)
    await writeFile(path, JSON.stringify(history))
    await assert.rejects(verifyRollbackProtection(options), /package identity/)
  })
})
