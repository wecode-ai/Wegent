import assert from 'node:assert/strict'
import { test } from 'node:test'
import { credentialRoundTripPassed } from '../e2e/desktop/upgrade-suite.mjs'

function evidence(protectedTarget) {
  const stages = ['source', 'upgraded', 'rolled-back', ...(protectedTarget ? ['re-upgraded'] : [])]
  return {
    toVersion: '1.1.0',
    target: 'a'.repeat(64),
    reupgrade: protectedTarget ? 'passed' : 'not-run',
    credentials: stages.map((stage, index) => ({
      stage,
      format: protectedTarget && index > 0 ? 3 : 2,
      storageVersion: protectedTarget && index % 2 === 1 ? 3 : 2,
      modelAuthenticated: true,
      cloudDeviceSignature: true,
      ...(['upgraded', 'rolled-back'].includes(stage) ? { writeAuthenticated: true } : {}),
    })),
    rollbackProtection: {
      version: '1.1.0',
      packageSha256: 'a'.repeat(64),
      kind: protectedTarget ? 'confirmation-required' : 'blocked',
      historyPreserved: true,
      downloadPrevented: true,
      ...(protectedTarget ? { retryConfirmed: true } : {}),
    },
  }
}

for (const protectedTarget of [false, true]) {
  test(`shared storage requires an upgraded write (protected target: ${protectedTarget})`, () => {
    const valid = evidence(protectedTarget)
    assert.equal(credentialRoundTripPassed(valid), true)
    for (const missing of [false, true]) {
      const invalid = structuredClone(valid)
      if (missing) delete invalid.credentials[1].writeAuthenticated
      else invalid.credentials[1].writeAuthenticated = false
      assert.equal(credentialRoundTripPassed(invalid), false)
    }
  })
}

test('format-preserving packages require authenticated writes and exact rollback protection', () => {
  assert.equal(credentialRoundTripPassed(evidence(false)), true)
  for (const change of [
    undefined,
    { version: '1.2.0' },
    { packageSha256: 'b'.repeat(64) },
    { kind: 'ignored' },
    { historyPreserved: false },
    { downloadPrevented: false },
  ]) {
    const value = evidence(false)
    value.rollbackProtection = change && { ...value.rollbackProtection, ...change }
    assert.equal(credentialRoundTripPassed(value), false)
  }
  const modern = evidence(false)
  modern.rollbackProtection.kind = 'confirmation-required'
  assert.equal(credentialRoundTripPassed(modern), true)
})

test('protected credentials always require the complete authenticated round trip', () => {
  assert.equal(credentialRoundTripPassed(evidence(true)), true)
  for (const field of ['historyPreserved', 'downloadPrevented', 'retryConfirmed']) {
    const missing = evidence(true)
    delete missing.rollbackProtection[field]
    assert.equal(credentialRoundTripPassed(missing), false)
  }
  const absent = evidence(true)
  delete absent.rollbackProtection
  assert.equal(credentialRoundTripPassed(absent), false)
  const short = evidence(true)
  short.credentials.pop()
  short.reupgrade = 'not-run'
  assert.equal(credentialRoundTripPassed(short), false)
  const missedMigration = evidence(false)
  missedMigration.credentials[1].storageVersion = 3
  assert.equal(credentialRoundTripPassed(missedMigration), false)
})

test('both contracts reject lost writes, failed authentication, downgrades and missing native metadata', () => {
  for (const protectedTarget of [false, true]) {
    for (const change of [
      { writeAuthenticated: false },
      { modelAuthenticated: false },
      { cloudDeviceSignature: false },
      { storageVersion: undefined },
      { format: 1 },
    ]) {
      const value = evidence(protectedTarget)
      Object.assign(value.credentials[2], change)
      assert.equal(credentialRoundTripPassed(value), false)
    }
  }
  const downgraded = evidence(true)
  downgraded.credentials[2].format = 2
  assert.equal(credentialRoundTripPassed(downgraded), false)
})

test('isolated migration preserves rollback files and keeps subsequent writes independent', () => {
  const value = evidence(true)
  value.credentials[2].format = 2
  for (const index of [1, 3]) {
    Object.assign(value.credentials[index], {
      storageMode: 'isolated-copy-once',
      writeAuthenticated: true,
      legacyFilesPreserved: true,
      legacyModelBindingsPreserved: true,
      newStoreIndependent: true,
    })
  }
  assert.equal(credentialRoundTripPassed(value), true)
  for (const [index, field] of [
    [1, 'legacyFilesPreserved'],
    [1, 'legacyModelBindingsPreserved'],
    [1, 'writeAuthenticated'],
    [3, 'newStoreIndependent'],
  ]) {
    for (const missing of [false, true]) {
      const invalid = structuredClone(value)
      if (missing) delete invalid.credentials[index][field]
      else invalid.credentials[index][field] = false
      assert.equal(credentialRoundTripPassed(invalid), false)
    }
  }
  const invalid = structuredClone(value)
  invalid.credentials[3].storageMode = 'unknown'
  assert.equal(credentialRoundTripPassed(invalid), false)
})
