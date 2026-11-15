import * as WebBrowser from 'expo-web-browser'
import { confirmNativeAction, showErrorAlert } from './errorAlerts'

export const MOBILE_PRIVACY_POLICY_URL =
  'https://github.com/wecode-ai/Wegent/blob/main/docs/zh/wework/mobile-privacy.md'
const PUBLIC_POLICY_URLS = {
  zh: MOBILE_PRIVACY_POLICY_URL,
  en: 'https://github.com/wecode-ai/Wegent/blob/main/docs/en/wework/mobile-privacy.md',
}

export const MODEL_DATA_SHARING_NOTICE =
  '发送任务时，消息、所选附件，以及任务所需的文件内容和工具输出会发送给你选择的模型服务。AI 推理由该服务处理；Wegent 登录和远程连接是可选功能。'

export async function openPrivacyPolicy(language: 'zh' | 'en' = 'zh'): Promise<void> {
  try {
    await WebBrowser.openBrowserAsync(PUBLIC_POLICY_URLS[language])
  } catch (cause) {
    showErrorAlert(cause, { title: '无法打开隐私政策' })
  }
}

export function confirmModelDataSharing(onConfirm: () => Promise<void>): void {
  confirmNativeAction('允许向模型服务发送任务数据？', MODEL_DATA_SHARING_NOTICE, {
    confirmLabel: '同意并继续',
    onConfirm,
  })
}
