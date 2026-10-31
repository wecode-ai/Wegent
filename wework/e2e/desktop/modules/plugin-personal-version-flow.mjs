import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fetchJson, resultDir, WORKBENCH_READY_TIMEOUT_MS } from './shared.mjs'
import { accountPlugin, pluginApi, testId, until } from './plugin-regression-fixture.mjs'
import { waitForSnapshot } from './conversation-layout.mjs'
import { captureVerificationScreenshot } from './workspace-flows.mjs'
import { createZipFixture } from './zip-fixtures.mjs'
import { verifyPersonalRecipientManagedInstall } from './plugin-personal-recipient-install.mjs'
import {
  prepareAuthorAccountInstall,
  assertPersonalSourceUnchanged,
  disconnectPersonalPluginRuntime,
  resetPersonalRecipientAccount,
  switchPersonalPluginAccount,
  verifyAuthorAccountUninstall,
  verifyAuthorSourceUninstall,
  verifyPersonalSourcePersistence,
  verifyRecipientUninstallDoesNotRemoveOwner,
} from './plugin-personal-uninstall-flow.mjs'

const slug = 'desktop-e2e-personal-version'
const initialManifestName = 'Desktop E2E Personal Version'
const initialDisplayName = 'Personal Version E2E'
const updatedDisplayName = 'Updated Author Source E2E'
const currentVersion = '1.0.0'
const nextVersion = '1.1.0'

async function createPackage(root, version, manifestName = slug, displayName = updatedDisplayName) {
  const archivePath = join(root, `${slug}-${version}.zip`)
  await createZipFixture(archivePath, {
    '.codex-plugin/plugin.json': JSON.stringify({
      name: manifestName,
      version,
      description: 'Verifies explicit personal plugin version submission',
      author: { name: 'Wework Desktop E2E' },
      skills: './skills/',
      interface: {
        displayName,
        shortDescription: 'Submit an updated personal plugin release',
        longDescription: 'Verifies explicit version submission and preserves the shared audience.',
        developerName: 'Wework Desktop E2E',
        category: 'Developer Tools',
        capabilities: ['Skills'],
        defaultPrompt: 'Check the personal plugin release.',
      },
    }),
    'skills/version-check/SKILL.md': `---\nname: version-check\ndescription: Check the personal release.\n---\n\nRelease ${version}.\n`,
    'skills/audience-check/SKILL.md':
      '---\nname: audience-check\ndescription: Preserve the shared audience.\n---\n',
  })
  return archivePath
}

async function importPersonalSource(control, root, version, overwrite = false) {
  const preview = JSON.parse(
    await control.command('previewPluginImport', 'body', {
      value: JSON.stringify({
        archivePath: await createPackage(root, version),
        marketplacePath: join(root, 'wework-personal'),
      }),
    })
  )
  await writeFile(
    join(root, overwrite ? `import-preview-${version}.json` : 'import-preview.json'),
    `${JSON.stringify(preview, null, 2)}\n`
  )
  assert.equal(
    preview.valid,
    true,
    `Personal source import failed validation: ${JSON.stringify(preview.issues)}`
  )
  const imported = JSON.parse(
    await control.command('importPluginPackage', 'body', {
      value: JSON.stringify({ preview, overwrite }),
    })
  )
  assert.equal(imported.version, version)
  assert.equal(imported.displayName, updatedDisplayName)
}

export async function verifyPersonalPluginVersionSubmission({
  cloudEnvironment,
  control,
  restartDesktopApp: restartDesktopProcess,
  executorHome,
  codexHome,
  userDataDirectory,
  verifySharedLifecycle,
}) {
  assert.equal(
    typeof verifySharedLifecycle,
    'function',
    'The existing plugin lifecycle is required'
  )
  const flowStartedAt = Date.now()
  const commandStart = control.commandHistory.length
  const runtimeCost = { processRestarts: [], accountSwitches: [], phases: [] }
  let sharedLifecycleDurationMs = 0
  let sharingLifecycle = false
  let phaseStartedAt = flowStartedAt
  const recordPhase = phase => {
    const completedAt = Date.now()
    const cost = { phase, durationMs: completedAt - phaseStartedAt }
    runtimeCost.phases.push(cost)
    console.log(`[personal-plugin-phase-cost] ${JSON.stringify(cost)}`)
    phaseStartedAt = completedAt
  }
  const restartDesktopApp = async options => {
    const startedAt = Date.now()
    await restartDesktopProcess(options)
    const runtimeHomeSwitch = Boolean(options?.appEnvironmentOverrides?.WEGENT_EXECUTOR_HOME)
    // Controller readiness precedes the lazy workbench mount and startup route
    // restoration. Use the mounted shell's navigation after it becomes ready.
    await control.command('waitFor', testId('new-chat-button'), {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    if (runtimeHomeSwitch) {
      await control.command('clickWhenEnabled', testId('plugins-button'))
      await control.command('waitFor', testId('plugins-search-input'))
    }
    runtimeCost.processRestarts.push({
      deviceSwitch: options?.expectNewDeviceIdentity === true,
      runtimeHomeSwitch,
      sharedLifecycle: sharingLifecycle,
      durationMs: Date.now() - startedAt,
    })
  }
  await control.command('navigate', 'body', { value: '/' })
  const root = join(resultDir, 'personal-version-fixture')
  await mkdir(root, { recursive: true })
  const request = (path, method = 'GET', body) =>
    fetchJson(`${cloudEnvironment.backendUrl}/api${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${cloudEnvironment.authToken}`,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  const recipient = await request('/admin/users', 'POST', {
    user_name: `personal-version-recipient-${process.pid}`,
    password: `Personal-version-E2E-${process.pid}-A1!`,
    role: 'user',
    auth_source: 'password',
  })
  const packageBytes = await readFile(
    await createPackage(root, currentVersion, initialManifestName, initialDisplayName)
  )
  const initialized = await request('/plugins/submissions/init', 'POST', {
    slug,
    displayName: initialDisplayName,
    version: currentVersion,
    filename: `${slug}.zip`,
    sha256: createHash('sha256').update(packageBytes).digest('hex'),
    sizeBytes: packageBytes.length,
    listingType: 'plugin',
    purpose: 'restricted_share',
    visibility: 'personal',
    targets: [
      { entityType: 'user', entityId: String(recipient.id), displayName: recipient.user_name },
    ],
    allowCopy: true,
  })
  const uploaded = await fetch(new URL(initialized.uploadUrl, cloudEnvironment.backendUrl), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/zip' },
    body: packageBytes,
  })
  assert.equal(uploaded.ok, true, `Personal fixture upload failed: HTTP ${uploaded.status}`)
  const completed = await request(
    `/plugins/submissions/${initialized.submissionId}/complete`,
    'POST'
  )
  assert.equal(completed.submission.status, 'approved')
  const pluginPath = `/plugins/marketplace/${initialized.pluginId}`
  const before = await request(pluginPath)
  const accessBefore = await request(`${pluginPath}/access`)
  assert.equal(before.name, initialManifestName)
  assert.equal(before.displayName, initialDisplayName)
  assert.equal(before.version, currentVersion)
  assert.equal(accessBefore.targets.length, 1)
  assert.equal(accessBefore.allowCopy, true)

  // The cloud fixture owns the old release; native import creates the real editable source.
  await importPersonalSource(control, root, nextVersion)
  await control.command('navigate', 'body', { value: '/plugins' })
  await control.command('waitFor', testId('plugins-search-input'))
  await control.command('click', testId('plugins-distribution-tab-personal'))
  await control.command('fill', testId('plugins-search-input'), { value: initialDisplayName })
  // Native import invalidates its read cache without updating the mounted page.
  await control.command('clickWhenEnabled', testId('plugins-refresh-button'))
  await control.command('waitFor', testId(`plugin-marketplace-row-${initialized.pluginId}`))
  await control.command('click', testId(`plugin-marketplace-row-${initialized.pluginId}`))
  await control.command('waitFor', testId('plugin-version-submit-notice'), { text: nextVersion })
  await captureVerificationScreenshot(control, 'personal-plugin-version-pending.png')
  await control.command('click', testId('plugin-version-submit-open'))
  await control.command('waitFor', testId('plugin-version-submit-drawer'))
  await control.command('waitFor', testId('plugin-version-submit-current'), {
    text: currentVersion,
  })
  await control.command('waitFor', testId('plugin-version-submit-next'), { text: nextVersion })
  await control.command('click', testId('plugin-version-submit-close'))
  assert.equal((await request(pluginPath)).latestReleaseId, before.latestReleaseId)
  assert.deepEqual(await request(`${pluginPath}/access`), accessBefore)

  await control.command('click', testId('plugin-version-submit-open'))
  await control.command('waitFor', testId('plugin-version-submit-drawer'))
  await control.command('fill', testId('plugin-version-submit-notes'), {
    value: 'Update the personal source while preserving its existing audience.',
  })
  await captureVerificationScreenshot(control, 'personal-plugin-version-confirm.png')
  await control.command('clickWhenEnabled', testId('plugin-version-submit-confirm'), {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  let after = await until(
    () => request(pluginPath),
    plugin => plugin.version === nextVersion,
    'Submitting the new personal source did not advance the shared release'
  )
  assert.notEqual(after.latestReleaseId, before.latestReleaseId)
  assert.equal(after.id, before.id, 'Normalized name submission created another cloud Plugin')
  assert.equal(after.name, slug, 'The latest real source manifest was not applied to the listing')
  assert.equal(after.displayName, updatedDisplayName)
  assert.deepEqual(await request(`${pluginPath}/access`), accessBefore)
  await waitForSnapshot(
    control,
    snapshot =>
      !snapshot.testIds.includes('plugin-version-submit-drawer') &&
      !snapshot.testIds.includes('plugin-version-submit-notice'),
    'A successful personal version submission left the pending-version notice visible'
  )
  await captureVerificationScreenshot(control, 'personal-plugin-version-shared.png')
  const login = await request('/auth/login', 'POST', {
    user_name: recipient.user_name,
    password: `Personal-version-E2E-${process.pid}-A1!`,
  })
  assert.ok(login.access_token, 'The real recipient login did not return an access token')
  const recipientCloud = { backendUrl: cloudEnvironment.backendUrl, authToken: login.access_token }
  recordPhase('version-submission')
  const ownerAccount = await prepareAuthorAccountInstall({
    control,
    cloudEnvironment,
    plugin: after,
    executorHome,
  })
  recordPhase('author-account-install')
  // Cross-account checks need real membership, but not a second Runtime yet.
  await pluginApi(recipientCloud, `/plugins/marketplace/${after.id}/install`, 'POST')
  const recipientAccount = await accountPlugin(recipientCloud, after.name)
  assert.ok(recipientAccount, 'The cross-account fixture omitted recipient membership')
  assert.equal(recipientAccount.spec.pluginId, Number(after.id))
  assert.equal(recipientAccount.spec.releaseId, after.latestReleaseId)
  recordPhase('recipient-account-fixture')
  let crossAccountUninstall
  try {
    runtimeCost.accountSwitches.push(await switchPersonalPluginAccount(control, recipientCloud))
    await control.command('navigate', 'body', { value: '/plugins' })
    await control.command('clickIfPresent', testId('plugin-detail-back-button'))
    await control.command('waitFor', testId('plugins-search-input'))
    await control.command('click', testId('plugins-distribution-tab-personal'))
    await control.command('fill', testId('plugins-search-input'), { value: slug })
    await control.command('click', testId('plugins-refresh-button'))
    await control.command('waitFor', testId(`plugin-marketplace-row-${initialized.pluginId}`))
    await control.command('click', testId(`plugin-marketplace-row-${initialized.pluginId}`))
    await control.command('click', 'button[data-testid^="plugin-detail-actions-"]')
    await waitForSnapshot(
      control,
      snapshot =>
        !snapshot.testIds.some(
          id =>
            id.startsWith('plugin-detail-share-') ||
            id.startsWith('plugin-detail-edit-') ||
            id.startsWith('plugin-detail-delete-')
        ) &&
        !snapshot.testIds.includes('plugin-detail-manage-access') &&
        !snapshot.testIds.includes('plugin-version-submit-open') &&
        snapshot.testIds.some(id => id.startsWith('plugin-detail-uninstall-')),
      'The recipient inherited author actions from the local personal source'
    )
    await captureVerificationScreenshot(control, 'personal-plugin-recipient-read-only.png')
    await expectHttpStatus(
      cloudEnvironment.backendUrl,
      `${pluginPath}/owner`,
      login.access_token,
      404
    )
    crossAccountUninstall = await verifyRecipientUninstallDoesNotRemoveOwner({
      control,
      cloudEnvironment,
      recipientCloud,
      plugin: after,
      source: ownerAccount.source,
      ownerIdentity: ownerAccount.identity,
    })

    const recipientRuntimeWork = () =>
      fetchJson(`${cloudEnvironment.backendUrl}/api/runtime-work`, {
        headers: { Authorization: `Bearer ${login.access_token}` },
      })
    const workBeforeEdit = await recipientRuntimeWork()
    assert.ok(
      Number.isSafeInteger(workBeforeEdit.totalTasks),
      'Runtime work omitted the task count'
    )
    await control.command('navigate', 'body', {
      value: `/plugins/create?edit=${encodeURIComponent(slug)}`,
    })
    await control.command('waitFor', testId('plugin-create-prompt-input'))
    await control.command('fill', testId('plugin-create-prompt-input'), {
      value: 'Update the scheduling capability of this shared plugin.',
    })
    await control.command('clickWhenEnabled', testId('plugin-create-submit-button'))
    await waitForSnapshot(
      control,
      snapshot =>
        snapshot.testIds.includes('plugin-create-workspace') &&
        /只能编辑自己创建或复制|created or copied|plugin not found|404/i.test(snapshot.text),
      'The recipient direct-edit URL did not reject the retained author source'
    )
    const workAfterEdit = await recipientRuntimeWork()
    assert.equal(
      workAfterEdit.totalTasks,
      workBeforeEdit.totalTasks,
      'The rejected recipient edit created a real runtime task'
    )
    await captureVerificationScreenshot(
      control,
      'personal-plugin-recipient-direct-edit-rejected.png'
    )
    await writeFile(
      join(root, 'recipient-direct-edit-rejected.json'),
      `${JSON.stringify({ before: workBeforeEdit.totalTasks, after: workAfterEdit.totalTasks })}\n`
    )
  } finally {
    runtimeCost.accountSwitches.push(await switchPersonalPluginAccount(control, cloudEnvironment))
  }
  recordPhase('recipient-cross-account')
  await verifyAuthorAccountUninstall({
    control,
    cloudEnvironment,
    recipientCloud,
    plugin: after,
    source: ownerAccount.source,
    ownerIdentity: ownerAccount.identity,
    executorHome,
    access: accessBefore,
  })
  recordPhase('author-account-uninstall')
  // Verify the uninstalled source across the existing installation checkpoint's
  // real restarts, while preserving that checkpoint's own fixtures and assertions.
  const authorLifecycle = await verifyAuthorSourceUninstall({
    control,
    cloudEnvironment,
    recipientCloud,
    plugin: after,
    access: accessBefore,
    codexHome,
    verifyRestartPersistence: async verifyUninstalled => {
      recordPhase('author-source-uninstall')
      const startedAt = Date.now()
      sharingLifecycle = true
      try {
        await verifyPersonalSourcePersistence({
          runLifecycle: verifySharedLifecycle,
          restartDesktopApp,
          verifyUninstalled,
        })
      } finally {
        sharingLifecycle = false
      }
      sharedLifecycleDurationMs = Date.now() - startedAt
      recordPhase('shared-plugin-lifecycle')
    },
    version: '1.1.1',
    prepareSource: version => importPersonalSource(control, root, version, true),
  })
  after = authorLifecycle.plugin
  recordPhase('author-source-reinstall')
  const resetRecipientInstallId = await resetPersonalRecipientAccount({
    cloudEnvironment,
    recipientCloud,
    plugin: after,
    source: authorLifecycle.source,
    recipient: authorLifecycle.recipient,
    access: accessBefore,
  })
  recordPhase('recipient-account-reset')
  // End on the clean recipient Runtime. The checkpoint owns teardown, so there
  // is no return to the author Home or dedicated source-persistence restart.
  const managedRecipient = await verifyPersonalRecipientManagedInstall({
    cloudEnvironment,
    control,
    restartDesktopApp,
    plugin: after,
    recipientToken: login.access_token,
    recipientId: recipient.id,
    userDataDirectory,
  })
  await assertPersonalSourceUnchanged(authorLifecycle.source)
  assert.equal(await accountPlugin(cloudEnvironment, after.name), undefined)
  assert.ok(managedRecipient.runtimeInstanceId, 'The recipient Runtime omitted its identity')
  const recipientDevice = await until(
    async () =>
      (await pluginApi(recipientCloud, '/devices')).items?.find(
        device =>
          device.runtime_instance_id === managedRecipient.runtimeInstanceId &&
          device.app_device_id === managedRecipient.deviceId &&
          device.status === 'online'
      ),
    Boolean,
    'The managed package has no online recipient Runtime registration'
  )
  await disconnectPersonalPluginRuntime(control, recipientCloud, after)
  await until(
    () => pluginApi(recipientCloud, '/devices'),
    devices =>
      devices.items?.some(
        device => device.id === recipientDevice.id && device.status === 'offline'
      ),
    'The recipient device must be offline before revocation verification'
  )
  recordPhase('recipient-managed-install')
  const ownerContract = await verifyOwnerApiContract({
    control,
    cloudEnvironment,
    pluginPath,
    pluginId: after.id,
    recipientToken: login.access_token,
    request,
  })
  const recipientAccess = await verifyRecipientAccessBoundary({
    backendUrl: cloudEnvironment.backendUrl,
    recipientToken: login.access_token,
    pluginPath,
    request,
    expectedAccess: accessBefore,
  })
  const rejectedPackage = await verifyWrongPackageRejected({
    cloudEnvironment,
    root,
    pluginPath,
    request,
    expectedPlugin: after,
    expectedAccess: accessBefore,
  })
  const revokedAccess = await verifyRevocationDuringSubmission({
    cloudEnvironment,
    root,
    pluginPath,
    request,
    recipientToken: login.access_token,
  })
  recordPhase('http-contracts')
  assert.equal(
    runtimeCost.processRestarts.length,
    3,
    'Personal publication added a process restart'
  )
  assert.ok(
    runtimeCost.processRestarts.every(restart => !restart.deviceSwitch),
    'Personal publication must reuse the initialized Electron device'
  )
  assert.deepEqual(
    runtimeCost.processRestarts.map(restart => restart.runtimeHomeSwitch),
    [false, false, true],
    'Both shared restarts must retain the author Home before the final recipient switch'
  )
  assert.deepEqual(
    runtimeCost.processRestarts.map(restart => restart.sharedLifecycle),
    [true, true, false],
    'Personal publication must add only the final recipient Runtime restart'
  )
  assert.equal(runtimeCost.accountSwitches.length, 2)
  const flowCommands = control.commandHistory.slice(commandStart)
  const accountCommands = flowCommands.filter(command => command.action === 'setCloudSessionToken')
  assert.equal(accountCommands.length, 2)
  assert.ok(
    accountCommands.every(command => command.value === '[redacted]'),
    'Account-switch diagnostics exposed a backend token'
  )
  const rendererReloads = flowCommands.filter(
    command => command.action === 'reloadMainWindow'
  ).length
  const runtimeReconnects = flowCommands.filter(
    command => command.action === 'reconnectLocalExecutorCloud'
  ).length
  assert.equal(rendererReloads, 0, 'Personal publication added a full renderer reload')
  assert.equal(runtimeReconnects, 2)
  const inventoryRefreshes = flowCommands.filter(
    command =>
      ['click', 'clickWhenEnabled'].includes(command.action) &&
      command.selector === testId('plugins-refresh-button')
  ).length
  const durationMs = Date.now() - flowStartedAt
  const cost = {
    ...runtimeCost,
    rendererReloads,
    runtimeReconnects,
    inventoryRefreshes,
    durationMs,
    sharedLifecycleDurationMs,
  }
  console.log(`[personal-plugin-cost] ${JSON.stringify(cost)}`)
  await writeFile(
    join(root, 'verification.json'),
    `${JSON.stringify(
      {
        before,
        after,
        access: accessBefore,
        managedRecipient,
        resetRecipientInstallId,
        crossAccountUninstall,
        ownerContract,
        recipientAccess,
        rejectedPackage,
        revokedAccess,
        runtimeCost: cost,
      },
      null,
      2
    )}\n`
  )
  // The isolated cloud fixture and executor teardown own this account and local source.
}

async function expectHttpStatus(backendUrl, path, token, status, method = 'GET', body) {
  const response = await fetch(`${backendUrl}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10_000),
  })
  assert.equal(response.status, status, `${method} ${path} returned an unexpected status`)
  return response.json()
}

async function verifyRecipientAccessBoundary({
  backendUrl,
  recipientToken,
  pluginPath,
  request,
  expectedAccess,
}) {
  await expectHttpStatus(backendUrl, pluginPath, recipientToken, 200)
  await expectHttpStatus(backendUrl, `${pluginPath}/access`, recipientToken, 404)
  await expectHttpStatus(backendUrl, `${pluginPath}/access`, recipientToken, 404, 'PUT', {
    scope: 'private',
    targets: [],
    allowCopy: false,
  })
  assert.deepEqual(await request(`${pluginPath}/access`), expectedAccess)
  return { canRead: true, aclReadStatus: 404, aclWriteStatus: 404 }
}

async function verifyOwnerApiContract({
  control,
  cloudEnvironment,
  pluginPath,
  pluginId,
  recipientToken,
  request,
}) {
  await control.command('navigate', 'body', { value: '/' })
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('plugins-workspace'),
    'Owner API fixture changes require the plugin workspace to unmount'
  )
  const [original] = await cloudEnvironment.queryDatabase(
    'SELECT visibility, status FROM plugins WHERE id = %s',
    [Number(pluginId)]
  )
  assert.ok(original, 'The owner API fixture plugin is missing')
  const verified = []
  try {
    for (const visibility of ['personal', 'workspace', 'public']) {
      for (const status of ['published', 'unpublished', 'pending_review']) {
        await cloudEnvironment.executeDatabase(
          'UPDATE plugins SET visibility = %s, status = %s WHERE id = %s',
          [visibility, status, Number(pluginId)]
        )
        assert.deepEqual(await request(`${pluginPath}/owner`), { pluginId: Number(pluginId) })
        await expectHttpStatus(
          cloudEnvironment.backendUrl,
          `${pluginPath}/owner`,
          recipientToken,
          404
        )
        verified.push({ visibility, status, owner: 200, recipient: 404 })
      }
    }
    await cloudEnvironment.executeDatabase('UPDATE plugins SET status = %s WHERE id = %s', [
      'deleted',
      Number(pluginId),
    ])
    await expectHttpStatus(
      cloudEnvironment.backendUrl,
      `${pluginPath}/owner`,
      cloudEnvironment.authToken,
      404
    )
    await expectHttpStatus(cloudEnvironment.backendUrl, `${pluginPath}/owner`, recipientToken, 404)
    verified.push({ status: 'deleted', owner: 404, recipient: 404 })
  } finally {
    await cloudEnvironment.executeDatabase(
      'UPDATE plugins SET visibility = %s, status = %s WHERE id = %s',
      [original.visibility, original.status, Number(pluginId)]
    )
  }
  return verified
}

async function uploadVersionFixture({ request, backendUrl, packageBytes, version }) {
  const initialized = await request('/plugins/submissions/init', 'POST', {
    slug,
    displayName: 'Personal Version E2E',
    version,
    filename: `${slug}-${version}.zip`,
    sha256: createHash('sha256').update(packageBytes).digest('hex'),
    sizeBytes: packageBytes.length,
    listingType: 'plugin',
    purpose: 'restricted_share',
    visibility: 'personal',
    releaseNotes: 'Verify personal release HTTP permission boundaries.',
  })
  const uploaded = await fetch(new URL(initialized.uploadUrl, backendUrl), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/zip' },
    body: packageBytes,
  })
  assert.equal(uploaded.status, 204, 'The HTTP boundary fixture package failed to upload')
  return initialized
}

async function verifyWrongPackageRejected({
  cloudEnvironment,
  root,
  pluginPath,
  request,
  expectedPlugin,
  expectedAccess,
}) {
  const version = '1.2.0'
  const archivePath = join(root, `${slug}-wrong-source.zip`)
  await createZipFixture(archivePath, {
    '.codex-plugin/plugin.json': JSON.stringify({
      name: `${slug}-wrong-source`,
      version,
      description: 'Reject a package belonging to another source.',
      skills: './skills/',
    }),
    'skills/wrong-source/SKILL.md':
      '---\nname: wrong-source\ndescription: A different source identity.\n---\n',
  })
  const initialized = await uploadVersionFixture({
    request,
    backendUrl: cloudEnvironment.backendUrl,
    packageBytes: await readFile(archivePath),
    version,
  })
  const rejection = await expectHttpStatus(
    cloudEnvironment.backendUrl,
    `/plugins/submissions/${initialized.submissionId}/complete`,
    cloudEnvironment.authToken,
    422,
    'POST'
  )
  assert.equal(rejection.detail, 'Personal plugin slug must match the manifest name')
  const unchanged = await request(pluginPath)
  assert.equal(unchanged.name, expectedPlugin.name)
  assert.equal(unchanged.latestReleaseId, expectedPlugin.latestReleaseId)
  assert.deepEqual(await request(`${pluginPath}/access`), expectedAccess)
  const failed = await request(`/plugins/submissions/${initialized.submissionId}`)
  assert.equal(failed.status, 'rejected')
  return {
    status: 422,
    submissionId: initialized.submissionId,
    latestReleaseId: unchanged.latestReleaseId,
  }
}

async function verifyRevocationDuringSubmission({
  cloudEnvironment,
  root,
  pluginPath,
  request,
  recipientToken,
}) {
  const version = '1.3.0'
  const initialized = await uploadVersionFixture({
    request,
    backendUrl: cloudEnvironment.backendUrl,
    packageBytes: await readFile(await createPackage(root, version)),
    version,
  })
  const revoked = await request(`${pluginPath}/access`, 'PUT', {
    scope: 'private',
    targets: [],
    allowCopy: false,
  })
  const completed = await request(
    `/plugins/submissions/${initialized.submissionId}/complete`,
    'POST'
  )
  assert.equal(completed.submission.status, 'approved')
  assert.equal(completed.plugin.latestReleaseId, initialized.releaseId)
  assert.equal(completed.plugin.version, version)
  const access = await request(`${pluginPath}/access`)
  const permissions = ({ pluginId, scope, targets, allowCopy }) => ({
    pluginId,
    scope,
    targets,
    allowCopy,
  })
  assert.deepEqual(permissions(access), permissions(revoked))
  assert.equal(revoked.pluginId, initialized.pluginId)
  assert.equal(revoked.scope, 'private')
  assert.deepEqual(revoked.targets, [])
  assert.equal(revoked.allowCopy, false)
  // PUT reports affected installations; GET defaults this non-persisted count to zero.
  assert.equal(revoked.revocationPendingCount, 1)
  assert.equal(access.revocationPendingCount, 0)
  // The recipient is offline after the managed-install phase; its account removal
  // must be committed even though physical cleanup waits for device reconnection.
  assert.equal(
    await accountPlugin(
      { backendUrl: cloudEnvironment.backendUrl, authToken: recipientToken },
      slug
    ),
    undefined,
    'Publishing a release restored the revoked recipient account installation'
  )
  await expectHttpStatus(cloudEnvironment.backendUrl, pluginPath, recipientToken, 404)
  return {
    latestReleaseId: initialized.releaseId,
    access,
    affectedInstallationCount: revoked.revocationPendingCount,
    recipientMembershipRemoved: true,
    recipientReadStatus: 404,
  }
}
