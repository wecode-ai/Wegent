const fs = require('fs')
const path = require('path')

// Supported languages list (excluding existing en and zh-CN)
const languages = [
  'ca',
  'de',
  'es',
  'fr',
  'hi',
  'id',
  'it',
  'ja',
  'ko',
  'nl',
  'pl',
  'pt-BR',
  'ru',
  'tr',
  'vi',
  'zh-TW',
]

// Namespace list
const namespaces = ['common', 'chat', 'settings', 'history', 'prompts']

// Base directory
const localesDir = path.join(__dirname, '../src/i18n/locales')
const enDir = path.join(localesDir, 'en')

// Ensure locales directory exists
if (!fs.existsSync(localesDir)) {
  fs.mkdirSync(localesDir, { recursive: true })
}

// Create directory and files for each language
languages.forEach(lang => {
  const langDir = path.join(localesDir, lang)

  // Create language directory
  if (!fs.existsSync(langDir)) {
    fs.mkdirSync(langDir, { recursive: true })
  }

  // Create file for each namespace
  namespaces.forEach(ns => {
    const enFilePath = path.join(enDir, `${ns}.json`)
    const langFilePath = path.join(langDir, `${ns}.json`)

    // If English file exists and target file doesn't exist, copy English file as template
    if (fs.existsSync(enFilePath) && !fs.existsSync(langFilePath)) {
      const enContent = fs.readFileSync(enFilePath, 'utf8')
      fs.writeFileSync(langFilePath, enContent)
      console.log(`Created: ${lang}/${ns}.json`)
    }
  })
})

console.log('Locale files generation completed!')
console.log('Note: All files contain English text as placeholders.')
console.log('Please translate the content to the respective languages.')
