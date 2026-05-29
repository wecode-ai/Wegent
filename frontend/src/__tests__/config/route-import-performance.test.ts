// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import fs from 'fs'
import path from 'path'

const rootDir = path.resolve(__dirname, '../../..')

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8')
}

function expectNoStaticImport(relativePath: string, importPath: string) {
  const escapedImportPath = importPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  expect(readSource(relativePath)).not.toMatch(
    new RegExp(`^import\\s+(?!type\\b)[\\s\\S]*?from\\s+['"]${escapedImportPath}['"]`, 'm')
  )
}

describe('route import performance', () => {
  test.each([
    'src/app/(tasks)/knowledge/page.tsx',
    'src/app/(tasks)/knowledge/[namespace]/[kbName]/[[...docPath]]/page.tsx',
    'src/app/(tasks)/knowledge/project/[projectId]/page.tsx',
  ])('knowledge route avoids the feature barrel: %s', relativePath => {
    expect(readSource(relativePath)).not.toContain("from '@/features/knowledge'")
  })

  test.each([
    'src/app/(tasks)/feed/page.tsx',
    'src/app/(tasks)/feed/invitations/page.tsx',
    'src/app/(tasks)/feed/subscriptions/page.tsx',
  ])('feed route avoids the components barrel: %s', relativePath => {
    expect(readSource(relativePath)).not.toContain("from '@/features/feed/components'")
  })

  test('device chat route does not synchronously import the full ChatArea module', () => {
    expect(readSource('src/app/(tasks)/devices/chat/page.tsx')).not.toContain(
      "import { ChatArea } from '@/features/tasks/components/chat'"
    )
  })

  test('legacy tasks route dynamically loads the full ChatArea module', () => {
    expect(readSource('src/app/tasks/page.tsx')).not.toContain(
      "import { ChatArea } from '@/features/tasks/components/chat'"
    )
  })

  test('shared task route dynamically loads the full message renderer', () => {
    expect(readSource('src/app/shared/task/page.tsx')).not.toContain('import { MessageBubble')
  })

  test.each([
    '@/features/admin/components/UserList',
    '@/features/admin/components/PublicModelList',
    '@/features/admin/components/PublicRetrieverList',
    '@/features/admin/components/PublicSkillList',
    '@/features/admin/components/PublicGhostList',
    '@/features/admin/components/PublicShellList',
    '@/features/admin/components/PublicTeamList',
    '@/features/admin/components/PublicBotList',
    '@/features/admin/components/TemplateList',
    '@/features/admin/components/ApiKeyManagement',
    '@/features/admin/components/SystemConfigPanel',
    '@/features/admin/components/BackgroundExecutionMonitorPanel',
    '@/features/admin/components/DeviceMonitorPanel',
    '@/features/admin/components/IMChannelList',
  ])('admin route does not statically import tab panel: %s', importPath => {
    expectNoStaticImport('src/app/admin/page.tsx', importPath)
  })

  test.each([
    '@/features/settings/components/TeamListWithScope',
    '@/features/settings/components/ModelListWithScope',
    '@/features/settings/components/RetrieverListWithScope',
    '@/features/settings/components/ShellListWithScope',
    '@/features/settings/components/SkillListWithScope',
  ])('resource library manager does not statically import scoped manager: %s', importPath => {
    expectNoStaticImport('src/features/resource-library/components/MyResources.tsx', importPath)
  })

  test.each([
    './SubscriptionTimeline',
    './SubscriptionForm',
    './SubscriptionList',
    './FollowingSubscriptionList',
    './RentalSubscriptionList',
    './DiscoverPageInline',
    './MarketPageInline',
  ])('feed landing content does not statically import inactive panel: %s', importPath => {
    expectNoStaticImport('src/features/feed/components/SubscriptionPage.tsx', importPath)
  })

  test.each([
    '@/features/feed/components/SubscriptionForm',
    '@/features/feed/components/SubscriptionList',
    '@/features/feed/components/FollowingSubscriptionList',
    '@/features/feed/components/RentalSubscriptionList',
  ])('feed subscriptions page does not statically import inactive panel: %s', importPath => {
    expectNoStaticImport('src/app/(tasks)/feed/subscriptions/page.tsx', importPath)
  })

  test.each([
    'src/features/feed/components/SubscriptionList.tsx',
    'src/features/feed/components/SubscriptionTimeline.tsx',
    'src/features/feed/components/DiscoverHistoryDialog.tsx',
  ])('feed component dynamically loads conversation dialog: %s', relativePath => {
    expectNoStaticImport(relativePath, './SubscriptionConversationDialog')
  })
})
