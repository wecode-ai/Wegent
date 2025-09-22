import i18next from "i18next"
import { initReactI18next } from "react-i18next"

// 支持的语言列表
export const supportedLanguages = [
  'en', 'zh-CN'
]

// 动态导入翻译资源的函数
async function loadTranslations() {
  const resources: Record<string, Record<string, any>> = {}
  
  // 命名空间列表
  const namespaces = ['common', 'chat', 'settings', 'history', 'prompts']
  
  for (const lng of supportedLanguages) {
    resources[lng] = {}
    for (const ns of namespaces) {
      try {
        // 动态导入 JSON 文件
        const module = await import(`./locales/${lng}/${ns}.json`)
        resources[lng][ns] = module.default
      } catch (error) {
        // 如果文件不存在，使用空对象
        console.warn(`Translation file not found: ./locales/${lng}/${ns}.json`)
        resources[lng][ns] = {}
      }
    }
  }
  
  return resources
}

// 初始化 i18next
export async function initI18n() {
  const resources = await loadTranslations()
  
  await i18next.use(initReactI18next).init({
    lng: "zh-CN", // 默认语言设为中文
    fallbackLng: "en", // 回退语言为英文
    resources,
    interpolation: {
      escapeValue: false // React 已经处理了 XSS 防护
    },
    // 开发模式下显示调试信息
    debug: process.env.NODE_ENV === 'development',
    // 命名空间配置
    defaultNS: 'common',
    ns: ['common', 'chat', 'settings', 'history', 'prompts'],
  })
  
  return i18next
}

export default i18next