import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { normalizeFileViewerAssetManifest } from './lib/harness-runtime-metadata.mjs'

test('removes time and workspace paths from the DSH app asset manifest', () => {
  assert.deepEqual(
    normalizeFileViewerAssetManifest(
      {
        schemaVersion: 1,
        copiedAt: '2026-08-22T08:31:49.231Z',
        assets: [
          {
            rendererId: 'pdf',
            id: 'pdf-worker',
            to: '/tmp/build/wework-app/vendor/pdf/pdf.worker.mjs',
            copied: true,
          },
        ],
      },
      '/tmp/build/wework-app'
    ),
    {
      schemaVersion: 1,
      copiedAt: '1970-01-01T00:00:00.000Z',
      assets: [
        {
          rendererId: 'pdf',
          id: 'pdf-worker',
          to: 'vendor/pdf/pdf.worker.mjs',
          copied: true,
        },
      ],
    }
  )
})

test('rejects generated asset paths outside the packaged DSH app', () => {
  assert.throws(
    () =>
      normalizeFileViewerAssetManifest(
        { assets: [{ to: '/tmp/other/secret' }] },
        '/tmp/build/wework-app'
      ),
    /outside the DSH app output/
  )
})

test('normalizes assets reached through an equivalent filesystem path', t => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'wegent-harness-metadata-'))
  t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }))

  const workspaceRoot = path.join(temporaryRoot, 'Wegent')
  const outputRoot = path.join(workspaceRoot, 'wework-app')
  const assetPath = path.join(outputRoot, 'vendor', 'asset.js')
  mkdirSync(path.dirname(assetPath), { recursive: true })
  writeFileSync(assetPath, 'asset')

  const workspaceAlias = path.join(temporaryRoot, 'workspace-alias')
  symlinkSync(workspaceRoot, workspaceAlias, 'dir')

  assert.deepEqual(
    normalizeFileViewerAssetManifest(
      { assets: [{ to: path.join(workspaceAlias, 'wework-app', 'vendor', 'asset.js') }] },
      outputRoot
    ),
    {
      copiedAt: '1970-01-01T00:00:00.000Z',
      assets: [{ to: 'vendor/asset.js' }],
    }
  )
})
