#!/usr/bin/env node

// SPDX-FileCopyrightText: 2025 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Download fonts for:
 * 1) PDF rendering (CJK)
 * 2) Local web typography (Google Sans Flex / Google Sans)
 *
 * Features:
 * - Mirror fallback
 * - Skip via environment variables
 * - Progress and timeout
 * - Atomic write with temp file
 * - Configurable Google Sans CSS source URL(s) for internal deployments
 */

const https = require('https')
const http = require('http')
const fs = require('fs')
const path = require('path')

/* Environment switches */
if (process.env.SKIP_FONT_DOWNLOAD === '1') {
  console.log('🚫 Skip font download (SKIP_FONT_DOWNLOAD=1)')
  process.exit(0)
}

/* Paths */
const FONTS_DIR = path.join(__dirname, '..', 'public', 'fonts')
const PDF_FONT_DIR = FONTS_DIR
const GOOGLE_SANS_DIR = path.join(FONTS_DIR, 'google-sans')
const GOOGLE_SANS_CSS_OUTPUT = path.join(__dirname, '..', 'src', 'app', 'google-sans-local.css')
const DOWNLOAD_TIMEOUT = 30_000 // 30s
const GOOGLE_FONTS_USER_AGENT =
  process.env.GOOGLE_FONT_USER_AGENT ||
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36'

/* PDF font configuration */
const PDF_FONTS = [
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

/* Google Sans configuration */
const defaultGoogleSansCssUrls = [
  'https://fonts.googleapis.com/css2?family=Google+Sans:wght@400;500;700&family=Google+Sans+Flex:wght@400;500;700&display=swap',
]

const configuredGoogleSansCssUrls = (process.env.GOOGLE_SANS_CSS_URLS || '')
  .split(',')
  .map(url => url.trim())
  .filter(Boolean)

const googleSansCssUrls = configuredGoogleSansCssUrls.length
  ? configuredGoogleSansCssUrls
  : defaultGoogleSansCssUrls

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

function ensureDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
  }
}

function resolveRedirectUrl(currentUrl, location) {
  return new URL(location, currentUrl).toString()
}

function downloadFile(url, destPath, options = {}, maxRedirects = 5) {
  const tempPath = destPath + '.downloading'
  const protocol = url.startsWith('https') ? https : http
  const headers = options.headers || {}

  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) {
      reject(new Error('Too many redirects'))
      return
    }

    const req = protocol.get(url, { headers }, res => {
      // Redirect support
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = resolveRedirectUrl(url, res.headers.location)
        console.log(`  ↪ Redirect: ${redirectUrl}`)
        return downloadFile(redirectUrl, destPath, options, maxRedirects - 1)
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

function downloadText(url, options = {}, maxRedirects = 5) {
  const protocol = url.startsWith('https') ? https : http
  const headers = options.headers || {}

  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) {
      reject(new Error('Too many redirects'))
      return
    }

    const req = protocol.get(url, { headers }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = resolveRedirectUrl(url, res.headers.location)
        return downloadText(redirectUrl, options, maxRedirects - 1)
          .then(resolve)
          .catch(reject)
      }

      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }

      let data = ''
      res.setEncoding('utf8')
      res.on('data', chunk => {
        data += chunk
      })
      res.on('end', () => resolve(data))
    })

    req.setTimeout(DOWNLOAD_TIMEOUT, () => {
      req.destroy(new Error('Download timeout'))
    })

    req.on('error', reject)
  })
}

async function downloadWithFallback(urls, downloader, validator) {
  let lastError
  for (const url of urls) {
    try {
      console.log(`  🌐 Try: ${url}`)
      const result = await downloader(url)
      if (validator) {
        await validator(result, url)
      }
      return { url, result }
    } catch (err) {
      console.warn(`  ⚠ Failed: ${err.message}`)
      lastError = err
    }
  }
  throw lastError
}

function normalizeFontUrl(rawUrl) {
  return rawUrl.trim().replace(/^['"]|['"]$/g, '')
}

function collectFontUrlsFromCss(cssText) {
  const regex = /url\(([^)]+)\)/g
  const urls = []
  for (const match of cssText.matchAll(regex)) {
    const url = normalizeFontUrl(match[1])
    if (url.startsWith('http://') || url.startsWith('https://')) {
      urls.push(url)
    }
  }
  return Array.from(new Set(urls))
}

function toLocalFileName(fontUrl, index) {
  const urlObj = new URL(fontUrl)
  const baseName = path.basename(urlObj.pathname)
  const safeBaseName = baseName.replace(/[^A-Za-z0-9._-]/g, '_')
  const ext = path.extname(safeBaseName) || '.woff2'
  return `${String(index).padStart(2, '0')}-${safeBaseName || `font${ext}`}`
}

async function downloadPdfFonts() {
  let hasErrors = false

  for (const font of PDF_FONTS) {
    const destPath = path.join(PDF_FONT_DIR, font.name)
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
      await downloadWithFallback(
        font.urls,
        url => downloadFile(url, destPath),
        () => {
          const { size } = fs.statSync(destPath)
          if (font.minSize && size < font.minSize) {
            throw new Error(`File too small (${formatSize(size)})`)
          }
        }
      )

      const { size } = fs.statSync(destPath)
      console.log(`✓ Downloaded ${font.name} (${formatSize(size)})\n`)
    } catch (err) {
      if (fs.existsSync(destPath)) fs.unlinkSync(destPath)
      console.error(`✗ Failed to download ${font.name}: ${err.message}`)
      console.error('  PDF CJK support may be limited.\n')
      hasErrors = true
    }
  }

  return !hasErrors
}

async function downloadGoogleSansAssets() {
  try {
    console.log('⬇ Downloading local Google Sans assets')
    console.log(`  CSS source candidates: ${googleSansCssUrls.join(', ')}`)

    const { result: cssText } = await downloadWithFallback(googleSansCssUrls, url =>
      downloadText(url, {
        headers: {
          'User-Agent': GOOGLE_FONTS_USER_AGENT,
        },
      })
    )

    const remoteFontUrls = collectFontUrlsFromCss(cssText)
    if (remoteFontUrls.length === 0) {
      throw new Error('No font URLs found in Google Sans CSS response')
    }

    ensureDirectory(GOOGLE_SANS_DIR)
    const fileMap = new Map()

    for (let i = 0; i < remoteFontUrls.length; i++) {
      const remoteUrl = remoteFontUrls[i]
      const fileName = toLocalFileName(remoteUrl, i + 1)
      const destPath = path.join(GOOGLE_SANS_DIR, fileName)
      fileMap.set(remoteUrl, fileName)

      await downloadFile(remoteUrl, destPath, {
        headers: {
          'User-Agent': GOOGLE_FONTS_USER_AGENT,
        },
      })
    }

    const localCss = cssText.replace(/url\(([^)]+)\)/g, (match, rawUrl) => {
      const normalized = normalizeFontUrl(rawUrl)
      const localName = fileMap.get(normalized)
      if (!localName) return match
      return `url('/fonts/google-sans/${localName}')`
    })

    fs.writeFileSync(GOOGLE_SANS_CSS_OUTPUT, localCss, 'utf8')
    console.log(`✓ Generated ${path.relative(process.cwd(), GOOGLE_SANS_CSS_OUTPUT)}\n`)
    return true
  } catch (err) {
    console.error(`✗ Failed to download local Google Sans assets: ${err.message}`)
    console.error('  Web UI will fall back to system fonts.\n')
    return false
  }
}

async function main() {
  console.log('📦 Downloading font assets...\n')

  ensureDirectory(FONTS_DIR)

  let hasErrors = false

  if (process.env.SKIP_PDF_FONT_DOWNLOAD !== '1') {
    const pdfSuccess = await downloadPdfFonts()
    if (!pdfSuccess) hasErrors = true
  } else {
    console.log('🚫 Skip PDF font download (SKIP_PDF_FONT_DOWNLOAD=1)\n')
  }

  if (process.env.SKIP_UI_FONT_DOWNLOAD !== '1') {
    const uiSuccess = await downloadGoogleSansAssets()
    if (!uiSuccess) hasErrors = true
  } else {
    console.log('🚫 Skip UI font download (SKIP_UI_FONT_DOWNLOAD=1)\n')
  }

  if (hasErrors) {
    console.log('⚠ Some font assets failed to download. Build continues.')
  } else {
    console.log('✅ All font assets downloaded successfully!')
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message)
  process.exit(1)
})
