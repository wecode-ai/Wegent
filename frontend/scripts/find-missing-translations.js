const fs = require('fs');
const path = require('path');

// 基础目录
const localesDir = path.join(__dirname, '../src/i18n/locales');

// 动态获取支持的语言列表
const supportedLanguages = fs.readdirSync(localesDir).filter(file => {
  return fs.statSync(path.join(localesDir, file)).isDirectory();
});

// 动态获取命名空间列表 (基于英文目录)
const enDir = path.join(localesDir, 'en');
const namespaces = fs
  .readdirSync(enDir)
  .filter(file => file.endsWith('.json'))
  .map(file => file.replace('.json', ''));

// 解析命令行参数
const args = process.argv.slice(2);
const options = {};

args.forEach(arg => {
  if (arg.startsWith('--')) {
    const [key, value] = arg.substring(2).split('=');
    options[key] = value;
  }
});

// 递归获取对象的所有键路径
function getKeys(obj, prefix = '') {
  const keys = [];

  for (const key in obj) {
    if (obj.hasOwnProperty(key)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;

      if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
        keys.push(...getKeys(obj[key], fullKey));
      } else {
        keys.push(fullKey);
      }
    }
  }

  return keys;
}

// 检查占位符一致性
function checkPlaceholders(sourceText, targetText, key, sourceLang, targetLang) {
  const placeholderRegex = /\{\{(\w+)\}\}/g;
  const sourcePlaceholders = [...sourceText.matchAll(placeholderRegex)].map(match => match[1]);
  const targetPlaceholders = [...targetText.matchAll(placeholderRegex)].map(match => match[1]);

  const missingInTarget = sourcePlaceholders.filter(p => !targetPlaceholders.includes(p));
  const extraInTarget = targetPlaceholders.filter(p => !sourcePlaceholders.includes(p));

  if (missingInTarget.length > 0 || extraInTarget.length > 0) {
    console.log(`❌ Placeholder mismatch in ${targetLang} for key "${key}":`);
    if (missingInTarget.length > 0) {
      console.log(`   Missing: ${missingInTarget.map(p => `{{${p}}}`).join(', ')}`);
    }
    if (extraInTarget.length > 0) {
      console.log(`   Extra: ${extraInTarget.map(p => `{{${p}}}`).join(', ')}`);
    }
    return false;
  }

  return true;
}

// 加载翻译文件
function loadTranslation(lang, ns) {
  const filePath = path.join(localesDir, lang, `${ns}.json`);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    console.error(`❌ Error parsing ${lang}/${ns}.json:`, error.message);
    return null;
  }
}

// 检查单个语言的翻译
function checkLanguage(targetLang, targetNs = null) {
  const namespacesToCheck = targetNs ? [targetNs] : namespaces;
  let hasIssues = false;

  console.log(`\n🔍 Checking ${targetLang}...`);

  namespacesToCheck.forEach(ns => {
    console.log(`\n📁 Namespace: ${ns}`);

    const enTranslation = loadTranslation('en', ns);
    const targetTranslation = loadTranslation(targetLang, ns);

    if (!enTranslation) {
      console.log(`❌ English reference file not found: en/${ns}.json`);
      hasIssues = true;
      return;
    }

    if (!targetTranslation) {
      console.log(`❌ Translation file not found: ${targetLang}/${ns}.json`);
      hasIssues = true;
      return;
    }

    const enKeys = getKeys(enTranslation);
    const targetKeys = getKeys(targetTranslation);

    // 检查缺失的键
    const missingKeys = enKeys.filter(key => !targetKeys.includes(key));
    if (missingKeys.length > 0) {
      console.log(`❌ Missing keys in ${targetLang}/${ns}.json:`);
      missingKeys.forEach(key => console.log(`   - ${key}`));
      hasIssues = true;
    }

    // 检查多余的键
    const extraKeys = targetKeys.filter(key => !enKeys.includes(key));
    if (extraKeys.length > 0) {
      console.log(`❌ Extra keys in ${targetLang}/${ns}.json:`);
      extraKeys.forEach(key => console.log(`   + ${key}`));
      hasIssues = true;
    }

    // 检查占位符一致性
    const commonKeys = enKeys.filter(key => targetKeys.includes(key));
    commonKeys.forEach(key => {
      const enValue = getValueByPath(enTranslation, key);
      const targetValue = getValueByPath(targetTranslation, key);

      if (typeof enValue === 'string' && typeof targetValue === 'string') {
        if (!checkPlaceholders(enValue, targetValue, key, 'en', targetLang)) {
          hasIssues = true;
        }
      }
    });

    if (!hasIssues) {
      console.log(`✅ No issues found in ${ns}`);
    }
  });

  return !hasIssues;
}

// 根据路径获取对象值
function getValueByPath(obj, path) {
  return path.split('.').reduce((current, key) => current && current[key], obj);
}

// 主函数
function main() {
  console.log('🌍 Translation Checker');
  console.log('='.repeat(50));

  const targetLocale = options.locale;
  const targetFile = options.file;
  const targetArea = options.area;

  if (targetLocale && !supportedLanguages.includes(targetLocale)) {
    console.error(`❌ Unsupported locale: ${targetLocale}`);
    console.log(`Supported locales: ${supportedLanguages.join(', ')}`);
    process.exit(1);
  }

  if (targetFile && !namespaces.includes(targetFile.replace('.json', ''))) {
    console.error(`❌ Unsupported file: ${targetFile}`);
    console.log(`Supported files: ${namespaces.map(ns => `${ns}.json`).join(', ')}`);
    process.exit(1);
  }

  let allPassed = true;

  if (targetLocale) {
    // 检查特定语言
    const ns = targetFile ? targetFile.replace('.json', '') : null;
    const passed = checkLanguage(targetLocale, ns);
    allPassed = allPassed && passed;
  } else {
    // 检查所有语言
    supportedLanguages.forEach(lang => {
      if (lang === 'en') return; // 跳过英文参考

      const ns = targetFile ? targetFile.replace('.json', '') : null;
      const passed = checkLanguage(lang, ns);
      allPassed = allPassed && passed;
    });
  }

  console.log('\n' + '='.repeat(50));
  if (allPassed) {
    console.log('✅ All translations are complete and consistent!');
  } else {
    console.log('❌ Found translation issues. Please fix them.');
    process.exit(1);
  }
}

// 显示帮助信息
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Translation Checker Usage:

  node scripts/find-missing-translations.js [options]

Options:
  --locale=<lang>     Check specific locale (e.g., --locale=fr)
  --file=<file>       Check specific file (e.g., --file=chat.json)
  --area=<area>       Alias for --file (deprecated)
  --help, -h          Show this help message

Examples:
  node scripts/find-missing-translations.js
  node scripts/find-missing-translations.js --locale=fr
  node scripts/find-missing-translations.js --locale=fr --file=chat.json
  node scripts/find-missing-translations.js --file=settings.json

Supported locales: ${supportedLanguages.join(', ')}
Supported files: ${namespaces.map(ns => `${ns}.json`).join(', ')}
`);
  process.exit(0);
}

main();
