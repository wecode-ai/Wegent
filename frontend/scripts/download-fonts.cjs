#!/usr/bin/env node

// SPDX-FileCopyrightText: 2025 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Download fonts script for PDF generation
 * - Supports mirror fallback
 * - Supports skip via env
 * - Shows progress & timeout
 * - Atomic write with temp file
 */

const https = require('https')
const http = require('http')
const fs = require('fs')
const path = require('path')

/* =========================
 * Environment switches
 * ========================= */
if (process.env.SKIP_FONT_DOWNLOAD === '1') {
  console.log('🚫 Skip font download (SKIP_FONT_DOWNLOAD=1)')
  process.exit(0)
}

/* =========================
 * Font configuration
 * ========================= */
const FONTS = [
  {
    name: 'SourceHanSansSC-VF.ttf',
    description: 'Source Han Sans SC Variable (CJK support for PDF)',
    minSize: 20 * 1024 * 1024, // 20MB
    urls: [
      // 🚀 镜像优先（国内 / 亚洲更快）
      'https://ghproxy.com/https://raw.githubusercontent.com/adobe-fonts/source-han-sans/release/Variable/TTF/SourceHanSansSC-VF.ttf',
      // 官方地址 fallback
      'https://raw.githubusercontent.com/adobe-fonts/source-han-sans/release/Variable/TTF/SourceHanSansSC-VF.ttf',
    ],
  },
]

const FONTS_DIR = path.join(__dirname, '..', 'public', 'fonts')
const DOWNLOAD_TIMEOUT = 30_000 // 30s

/* =========================
 * Utilities
 * ========================= */
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function isFontComplete(filePath, minSize) {
  if (!fs.existsSync(filePath)) return false
  const { size } = fs.statSync(filePath)
  return !minSize || size >= minSize
}

/* =========================
 * Core download logic
 * ========================= */
function downloadFile(url, destPath, maxRedirects = 5) {
  const tempPath = destPath + '.downloading'
  const protocol = url.startsWith('https') ? https : http

  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) {
      reject(new Error('Too many redirects'))
      return
    }

    const req = protocol.get(url, res => {
      // Redirect support
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        console.log(`  ↪ Redirect: ${res.headers.location}`)
        return downloadFile(res.headers.location, destPath, maxRedirects - 1)
          .then(resolve)
          .catch(reject)
      }

      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }

      const total = Number(res.headers['content-length'] || 0)
      let downloaded = 0

      const fileStream = fs.createWriteStream(tempPath)

      res.on('data', chunk => {
        downloaded += chunk.length
        if (total) {
          process.stdout.write(
            `\r  ${(downloaded / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB`
          )
        }
      })

      res.on('end', () => {
        process.stdout.write('\n')
      })

      res.pipe(fileStream)

      fileStream.on('finish', () => {
        fileStream.close(() => {
          try {
            fs.renameSync(tempPath, destPath)
            resolve()
          } catch (err) {
            fs.unlink(tempPath, () => {})
            reject(err)
          }
        })
      })

      fileStream.on('error', err => {
        fs.unlink(tempPath, () => {})
        reject(err)
      })
    })

    req.setTimeout(DOWNLOAD_TIMEOUT, () => {
      req.destroy(new Error('Download timeout'))
    })

    req.on('error', err => {
      fs.unlink(tempPath, () => {})
      reject(err)
    })
  })
}

async function downloadWithFallback(urls, destPath) {
  let lastError
  for (const url of urls) {
    try {
      console.log(`  🌐 Try: ${url}`)
      await downloadFile(url, destPath)
      return
    } catch (err) {
      console.warn(`  ⚠ Failed: ${err.message}`)
      lastError = err
    }
  }
  throw lastError
}

/* =========================
 * Main
 * ========================= */
async function main() {
  console.log('📦 Downloading fonts for PDF generation...\n')

  if (!fs.existsSync(FONTS_DIR)) {
    fs.mkdirSync(FONTS_DIR, { recursive: true })
    console.log(`Created directory: ${FONTS_DIR}\n`)
  }

  let hasErrors = false

  for (const font of FONTS) {
    const destPath = path.join(FONTS_DIR, font.name)
    const tempPath = destPath + '.downloading'

    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath)
    }

    if (isFontComplete(destPath, font.minSize)) {
      const { size } = fs.statSync(destPath)
      console.log(`✓ ${font.name} already exists (${formatSize(size)})\n`)
      continue
    }

    if (fs.existsSync(destPath)) {
      fs.unlinkSync(destPath)
    }

    console.log(`⬇ Downloading ${font.name}`)
    console.log(`  ${font.description}`)

    try {
      await downloadWithFallback(font.urls, destPath)

      const { size } = fs.statSync(destPath)
      if (font.minSize && size < font.minSize) {
        throw new Error(`File too small (${formatSize(size)})`)
      }

      console.log(`✓ Downloaded ${font.name} (${formatSize(size)})\n`)
    } catch (err) {
      if (fs.existsSync(destPath)) fs.unlinkSync(destPath)
      console.error(`✗ Failed to download ${font.name}: ${err.message}`)
      console.error('  PDF CJK support may be limited.\n')
      hasErrors = true
    }
  }

  if (hasErrors) {
    console.log('⚠ Some fonts failed to download. Build continues.')
  } else {
    console.log('✅ All fonts downloaded successfully!')
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message)
  process.exit(1)
})
