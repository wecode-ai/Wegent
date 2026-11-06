// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { access, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveDocxEngine, resolveFileViewerVersion } from './file-viewer-version.mjs'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const FRONTEND_DIR = path.resolve(SCRIPT_DIR, '..')
const { version: FILE_VIEWER_VERSION } = await resolveFileViewerVersion(FRONTEND_DIR)
const {
  version: DOCX_VERSION,
  workerPath: DOCX_WORKER_PATH,
  jsZipPath: DOCX_JSZIP_PATH,
} = await resolveDocxEngine(FRONTEND_DIR)
const ASSET_VERSION = `${FILE_VIEWER_VERSION}-office-pdf-v3`
const TARGET_DIR = path.join(FRONTEND_DIR, 'public', 'file-viewer', ASSET_VERSION)
const STAMP_PATH = path.join(TARGET_DIR, '.office-assets-version')

const STAMP_VERSION = `${ASSET_VERSION}:docx-${DOCX_VERSION}`
const DOCX_WORKER_RELATIVE_PATH = `vendor/docx/${DOCX_VERSION}/docx.worker.js`
const DOCX_JSZIP_RELATIVE_PATH = `vendor/docx/${DOCX_VERSION}/jszip.min.js`

const REQUIRED_ASSETS = [
  DOCX_WORKER_RELATIVE_PATH,
  DOCX_JSZIP_RELATIVE_PATH,
  'vendor/docx/docx.worker.js',
  'vendor/docx/jszip.min.js',
  'vendor/xlsx/sheet.worker.js',
  'vendor/pptx/pptx.worker.js',
  'vendor/pdf/pdf.worker.mjs',
  'vendor/pdf/cmaps/Adobe-GB1-UCS2.bcmap',
  'vendor/pdf/wasm/openjpeg.wasm',
  'vendor/pdf/standard_fonts/LiberationSans-Regular.ttf',
]

const NON_OFFICE_ASSETS = [
  'vendor/drawio',
  'vendor/libarchive',
  'wasm',
  'flyfish-viewer-assets.json',
  'flyfish-viewer-manifest.json',
]

async function exists(targetPath) {
  try {
    await access(targetPath)
    return true
  } catch {
    return false
  }
}

async function isCurrent() {
  if (!(await exists(STAMP_PATH))) return false

  const version = (await readFile(STAMP_PATH, 'utf8')).trim()
  if (version !== STAMP_VERSION) return false

  const requiredChecks = await Promise.all(
    REQUIRED_ASSETS.map(relativePath => exists(path.join(TARGET_DIR, relativePath)))
  )
  const excludedChecks = await Promise.all(
    NON_OFFICE_ASSETS.map(relativePath => exists(path.join(TARGET_DIR, relativePath)))
  )
  return requiredChecks.every(Boolean) && excludedChecks.every(present => !present)
}

async function prepareAssets() {
  if (await isCurrent()) {
    console.log(`[file-viewer-assets] preview assets are current (${ASSET_VERSION})`)
    return
  }

  await mkdir(TARGET_DIR, { recursive: true })
  const { copyFileViewerAssets } = await import('file-viewer-copy-assets')
  await copyFileViewerAssets({ targetDir: TARGET_DIR, clean: true })
  // The copier bundles its own older DOCX engine. Stage the runtime's Worker
  // for both default consumers and the versioned URL used by the React viewer.
  await copyFile(DOCX_WORKER_PATH, path.join(TARGET_DIR, 'vendor/docx/docx.worker.js'))
  await copyFile(DOCX_JSZIP_PATH, path.join(TARGET_DIR, 'vendor/docx/jszip.min.js'))
  await mkdir(path.dirname(path.join(TARGET_DIR, DOCX_WORKER_RELATIVE_PATH)), { recursive: true })
  await copyFile(DOCX_WORKER_PATH, path.join(TARGET_DIR, DOCX_WORKER_RELATIVE_PATH))
  await copyFile(DOCX_JSZIP_PATH, path.join(TARGET_DIR, DOCX_JSZIP_RELATIVE_PATH))
  await Promise.all(
    NON_OFFICE_ASSETS.map(relativePath =>
      rm(path.join(TARGET_DIR, relativePath), { recursive: true, force: true })
    )
  )
  await writeFile(STAMP_PATH, `${STAMP_VERSION}\n`, 'utf8')

  if (!(await isCurrent())) {
    throw new Error('Flyfish document preview assets are incomplete after copying')
  }

  console.log(`[file-viewer-assets] prepared preview assets (${ASSET_VERSION})`)
}

await prepareAssets()
