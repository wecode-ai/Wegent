const fs = require('fs');
const path = require('path');

// 支持的语言列表（除了已有的 en 和 zh-CN）
const languages = [
  'ca', 'de', 'es', 'fr', 'hi', 'id', 'it', 'ja', 'ko', 
  'nl', 'pl', 'pt-BR', 'ru', 'tr', 'vi', 'zh-TW'
];

// 命名空间列表
const namespaces = ['common', 'chat', 'settings', 'history', 'prompts'];

// 基础目录
const localesDir = path.join(__dirname, '../src/i18n/locales');
const enDir = path.join(localesDir, 'en');

// 确保 locales 目录存在
if (!fs.existsSync(localesDir)) {
  fs.mkdirSync(localesDir, { recursive: true });
}

// 为每种语言创建目录和文件
languages.forEach(lang => {
  const langDir = path.join(localesDir, lang);
  
  // 创建语言目录
  if (!fs.existsSync(langDir)) {
    fs.mkdirSync(langDir, { recursive: true });
  }
  
  // 为每个命名空间创建文件
  namespaces.forEach(ns => {
    const enFilePath = path.join(enDir, `${ns}.json`);
    const langFilePath = path.join(langDir, `${ns}.json`);
    
    // 如果英文文件存在且目标文件不存在，则复制英文文件作为模板
    if (fs.existsSync(enFilePath) && !fs.existsSync(langFilePath)) {
      const enContent = fs.readFileSync(enFilePath, 'utf8');
      fs.writeFileSync(langFilePath, enContent);
      console.log(`Created: ${lang}/${ns}.json`);
    }
  });
});

console.log('Locale files generation completed!');
console.log('Note: All files contain English text as placeholders.');
console.log('Please translate the content to the respective languages.');