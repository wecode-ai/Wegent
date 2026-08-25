import assert from 'node:assert/strict'
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
