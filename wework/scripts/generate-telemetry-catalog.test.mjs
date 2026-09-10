import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCatalog, routeEventName, validateRegistry } from './generate-telemetry-catalog.mjs'

const validRegistry = {
  schemaVersion: 1,
  domain: 'smart_app',
  owner: 'wework/harness-apps',
  routes: [
    {
      key: 'smart_app.marketplace',
      feature: 'marketplace',
      name: { 'zh-CN': '打开智能工作台市场', en: 'Open Smart App marketplace' },
      description: {
        'zh-CN': '用户进入智能工作台市场入口',
        en: 'The user enters the Smart App marketplace',
      },
      match: {
        pathname: '/sites',
        query: { app_type: 'smart_app' },
        queryNot: { view: 'owned' },
      },
      publicProperties: [{ name: 'domain', type: 'enum', values: ['smart_app'] }],
    },
    {
      key: 'smart_app.owned',
      feature: 'owned',
      name: { 'zh-CN': '打开我的智能工作台', en: 'Open owned Smart Apps' },
      description: { 'zh-CN': '用户进入我的智能工作台', en: 'The user enters owned Smart Apps' },
      match: { pathname: '/sites', query: { app_type: 'smart_app', view: 'owned' } },
      publicProperties: [{ name: 'domain', type: 'enum', values: ['smart_app'] }],
    },
    {
      key: 'smart_app.app',
      feature: 'app',
      name: { 'zh-CN': '打开智能工作台', en: 'Open Smart App' },
      description: { 'zh-CN': '用户打开一个智能工作台', en: 'The user opens a Smart App' },
      match: { pathnamePrefix: '/app/harness-' },
      publicProperties: [{ name: 'domain', type: 'enum', values: ['smart_app'] }],
    },
  ],
  operations: [
    {
      key: 'smart_app.install',
      action: 'install',
      name: { 'zh-CN': '安装智能工作台', en: 'Install Smart App' },
      description: { 'zh-CN': '用户安装智能工作台', en: 'The user installs a Smart App' },
      failureStages: ['download', 'validate', 'install', 'confirm'],
      publicProperties: [{ name: 'domain', type: 'enum', values: ['smart_app'] }],
    },
    {
      key: 'smart_app.update',
      action: 'update',
      name: { 'zh-CN': '更新智能工作台', en: 'Update Smart App' },
      description: { 'zh-CN': '用户更新智能工作台', en: 'The user updates a Smart App' },
      failureStages: ['download', 'validate', 'install', 'confirm'],
      publicProperties: [{ name: 'domain', type: 'enum', values: ['smart_app'] }],
    },
    {
      key: 'smart_app.zip_import',
      action: 'zip_import',
      name: { 'zh-CN': '导入智能工作台 ZIP', en: 'Import Smart App ZIP' },
      description: { 'zh-CN': '用户导入智能工作台 ZIP', en: 'The user imports a Smart App ZIP' },
      failureStages: ['preview', 'validate', 'install', 'confirm'],
      publicProperties: [{ name: 'domain', type: 'enum', values: ['smart_app'] }],
    },
  ],
}

test('generates the nine approved Smart App events', () => {
  const catalog = buildCatalog(validRegistry)

  assert.deepEqual(
    catalog.events.map(event => event.name),
    [
      'smart_app_marketplace_opened',
      'smart_app_owned_opened',
      'smart_app_opened',
      'smart_app_install_succeeded',
      'smart_app_install_failed',
      'smart_app_update_succeeded',
      'smart_app_update_failed',
      'smart_app_zip_import_succeeded',
      'smart_app_zip_import_failed',
    ]
  )
})

test('maps the app route feature to the approved opened event name', () => {
  assert.equal(routeEventName('smart_app', 'app'), 'smart_app_opened')
})

test('rejects a registry entry without both descriptions', () => {
  const registry = structuredClone(validRegistry)
  delete registry.routes[0].description.en

  assert.throws(() => validateRegistry(registry), /description\.en is required/)
})

test('rejects duplicate keys, invalid names, duplicate events, and unknown public properties', () => {
  const duplicateKey = structuredClone(validRegistry)
  duplicateKey.routes[1].key = duplicateKey.routes[0].key
  assert.throws(() => validateRegistry(duplicateKey), /duplicate key/)

  const invalidAction = structuredClone(validRegistry)
  invalidAction.operations[0].action = 'install-app'
  assert.throws(() => validateRegistry(invalidAction), /snake_case/)

  const duplicateEvent = structuredClone(validRegistry)
  duplicateEvent.routes[1].feature = 'marketplace'
  assert.throws(() => validateRegistry(duplicateEvent), /duplicate event name/)

  const unknownProperty = structuredClone(validRegistry)
  unknownProperty.routes[0].publicProperties.push({
    name: 'smart_app_name',
    type: 'string',
  })
  assert.throws(() => validateRegistry(unknownProperty), /unknown public property/)
})

test('requires each operation to declare its failure stages', () => {
  const registry = structuredClone(validRegistry)
  registry.operations[0].failureStages = []

  assert.throws(() => validateRegistry(registry), /failureStages must not be empty/)
})
