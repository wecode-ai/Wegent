// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { access, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveFileViewerVersion } from './file-viewer-version.mjs'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const FRONTEND_DIR = path.resolve(SCRIPT_DIR, '..')
const { version: FILE_VIEWER_VERSION } = await resolveFileViewerVersion(FRONTEND_DIR)
const ASSET_VERSION = `${FILE_VIEWER_VERSION}-protected-docs-v1`
const TARGET_DIR = path.join(FRONTEND_DIR, 'public', 'file-viewer', ASSET_VERSION)
const STAMP_PATH = path.join(TARGET_DIR, '.office-assets-version')

const REQUIRED_ASSETS = [
  'vendor/docx/docx.worker.js',
  'vendor/docx/jszip.min.js',
  'vendor/xlsx/sheet.worker.js',
  'vendor/pptx/pptx.worker.js',
  'vendor/pdf/pdf.worker.mjs',
  'vendor/pdf/pdf.mjs',
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
  if (version !== ASSET_VERSION) return false

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
    console.log(`[file-viewer-assets] document assets are current (${ASSET_VERSION})`)
    return
  }

  await mkdir(TARGET_DIR, { recursive: true })
  const { copyFileViewerAssets } = await import('file-viewer-copy-assets')
  await copyFileViewerAssets({ targetDir: TARGET_DIR, clean: true })
  const pdfModulePath = fileURLToPath(import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs'))
  await copyFile(pdfModulePath, path.join(TARGET_DIR, 'vendor', 'pdf', 'pdf.mjs'))
  await Promise.all(
    NON_OFFICE_ASSETS.map(relativePath =>
      rm(path.join(TARGET_DIR, relativePath), { recursive: true, force: true })
    )
  )
  await writeFile(STAMP_PATH, `${ASSET_VERSION}\n`, 'utf8')

  if (!(await isCurrent())) {
    throw new Error('Flyfish Office assets are incomplete after copying')
  }

  console.log(`[file-viewer-assets] prepared document assets (${ASSET_VERSION})`)
}

await prepareAssets()
