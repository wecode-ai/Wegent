// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { copyFileViewerAssets } from 'file-viewer-copy-assets'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const FRONTEND_DIR = path.resolve(SCRIPT_DIR, '..')
const ASSET_VERSION = '2.1.27-office-v2'
const TARGET_DIR = path.join(FRONTEND_DIR, 'public', 'file-viewer', ASSET_VERSION)
const STAMP_PATH = path.join(TARGET_DIR, '.office-assets-version')

const REQUIRED_ASSETS = [
  'vendor/pdf/pdf.worker.mjs',
  'vendor/pdf/cmaps',
  'vendor/pdf/fonts',
  'vendor/pdf/standard_fonts',
  'vendor/pdf/wasm',
  'vendor/docx/docx.worker.js',
  'vendor/docx/jszip.min.js',
  'vendor/xlsx/sheet.worker.js',
  'vendor/pptx/pptx.worker.js',
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

  const checks = await Promise.all(
    REQUIRED_ASSETS.map(relativePath => exists(path.join(TARGET_DIR, relativePath)))
  )
  return checks.every(Boolean)
}

async function prepareAssets() {
  if (await isCurrent()) {
    console.log(`[file-viewer-assets] office assets are current (${ASSET_VERSION})`)
    return
  }

  await mkdir(TARGET_DIR, { recursive: true })
  await copyFileViewerAssets({ targetDir: TARGET_DIR, clean: true })
  await Promise.all(
    NON_OFFICE_ASSETS.map(relativePath =>
      rm(path.join(TARGET_DIR, relativePath), { recursive: true, force: true })
    )
  )
  await writeFile(STAMP_PATH, `${ASSET_VERSION}\n`, 'utf8')

  if (!(await isCurrent())) {
    throw new Error('Flyfish Office assets are incomplete after copying')
  }

  console.log(`[file-viewer-assets] prepared office assets (${ASSET_VERSION})`)
}

await prepareAssets()
