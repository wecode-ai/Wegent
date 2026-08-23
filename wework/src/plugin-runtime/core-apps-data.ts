import type { WorkbenchAppContribution } from './apps'

export const CORE_WORKBENCH_APPS = [
  {
    key: 'wework',
    labelKey: 'workbench.app_wework_label',
    label: '任务',
    descriptionKey: 'workbench.app_wework_description',
    description: '使用 AI 解决具体问题',
    mode: 'native',
    path: '/',
    requiresAuth: true,
  },
  {
    key: 'todo',
    labelKey: 'workbench.app_weloop_label',
    label: '项目空间',
    descriptionKey: 'workbench.app_weloop_description',
    description: '用 AI 管理项目的规划、执行与反馈',
    mode: 'native',
    path: '/todo',
    requiresAuth: true,
    hidden: true,
  },
  {
    key: 'wegent',
    labelKey: 'workbench.app_wegent_label',
    label: '智能体',
    descriptionKey: 'workbench.app_wegent_description',
    description: '构建并交付可嵌入业务的云端智能体',
    mode: 'iframe',
    requiresAuth: true,
    requiresCloud: true,
    hidden: true,
  },
] as const satisfies readonly WorkbenchAppContribution[]
