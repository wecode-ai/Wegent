import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { resolveElectronBinary } from './electron-binary.mjs'
import { resolveElectronLaunchArguments } from './electron-launch-arguments.mjs'
import { verifyWindowsDesktopDataStartup } from './workbench-desktop-startup.mjs'
import { verifyWindowsComponentPublication } from './workbench-component-publication.mjs'
import { verifyMacosLogStartup } from './workbench-log-startup.mjs'
import { verifyMissingDesktopUserData } from './workbench-missing-user-data.mjs'

export function packagedResourcesRoot(appBinary) {
  return process.platform === 'darwin'
    ? resolve(appBinary, '..', '..', 'Resources')
    : resolve(appBinary, '..', 'resources')
}

// Execute the packaged production gates, with real binaries and isolated updater state.
// Codex is deliberately an incompatible executor candidate, not a simulated old executor.
export async function verifyWorkbenchSchemaCompatibility({ appBinary, appEnvironment, resultDir }) {
  const root = join(resultDir, 'workbench-schema-compatibility')
  await mkdir(root, { recursive: true })
  const input = {
    root,
    resources: packagedResourcesRoot(appBinary),
    executor: appEnvironment.WEWORK_EXECUTOR_PATH,
    incompatibleExecutor: appEnvironment.CODEX_BINARY_PATH,
    path: appEnvironment.PATH,
  }
  assert.equal(typeof input.executor, 'string')
  assert.equal(typeof input.incompatibleExecutor, 'string')
  const missingDesktopUserData = await verifyMissingDesktopUserData({
    resources: input.resources,
    environment: appEnvironment,
    root: join(root, 'missing-desktop-user-data'),
  })
  const macosLogStartup =
    process.platform === 'darwin'
      ? await verifyMacosLogStartup({
          resources: input.resources,
          environment: appEnvironment,
          root: join(root, 'macos-log-startup'),
        })
      : undefined
  const windowsDesktopDataStartup =
    process.platform === 'win32'
      ? await verifyWindowsDesktopDataStartup({
          resources: input.resources,
          environment: appEnvironment,
          root: join(root, 'windows-desktop-startup'),
        })
      : undefined
  const windowsComponentPublication =
    process.platform === 'win32'
      ? await verifyWindowsComponentPublication({
          resources: input.resources,
          environment: appEnvironment,
          root: join(root, 'windows-component-publication'),
        })
      : undefined
  const script = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs/promises');
    const path = require('node:path');
    const { pathToFileURL } = require('node:url');
    const { app } = require('electron');
    (async () => {
      const input = JSON.parse(process.argv[2]);
      const userData = path.join(input.root, 'electron-user-data');
      await fs.mkdir(userData, { recursive: true });
      app.setPath('userData', userData);
      app.setPath('home', input.root);
      await app.whenReady();
      const appRoot = path.join(input.resources, 'app.asar');
      const metadata = JSON.parse(await fs.readFile(path.join(appRoot, 'package.json'), 'utf8'));
      const runtimeRoot = path.join(appRoot, path.dirname(metadata.main), 'runtime');
      const load = name => import(pathToFileURL(path.join(runtimeRoot, name + '.js')).href);
      const { packagedUpdaterCache, restoreNativeUpdaterCache } = await load('../host/app-update-cache');
      const updaterCacheRecoveryStates = [];
      if (metadata.weworkProductName) app.setName(metadata.weworkProductName);
      if (process.platform === 'darwin') {
        const logs = app.getPath('logs');
        assert.equal(logs, path.join(input.root, 'Library', 'Logs', metadata.weworkProductName || app.getName()));
        const updaterCache = packagedUpdaterCache(input.root, input.resources, {}, 'darwin');
        assert.equal(path.dirname(updaterCache), path.join(input.root, 'Library', 'Caches'));
        await fs.mkdir(updaterCache, { recursive: true });
        await fs.writeFile(path.join(updaterCache, 'marker'), 'before-upgrade');
        assert.equal((await fs.lstat(updaterCache)).isDirectory(), true);
        assert.equal(await fs.readFile(path.join(updaterCache, 'marker'), 'utf8'), 'before-upgrade');
        for (const state of ['recreated-source', 'replaced-target', 'dangling-bridge', 'invalid-journal']) {
          const fixtureRoot = path.join(input.root, 'updater-cache-recovery', state);
          const desktop = path.join(fixtureRoot, 'desktop');
          const cache = { source: path.join(fixtureRoot, 'system-cache'),
            target: path.join(desktop, 'updater-cache'),
            journal: path.join(desktop, 'migrations', 'desktop-updater-cache-v1.json') };
          await fs.mkdir(cache.target, { recursive: true });
          await fs.mkdir(path.dirname(cache.journal), { recursive: true });
          await fs.writeFile(cache.journal, '{}');
          await fs.writeFile(path.join(cache.target, 'marker'), 'retained-update');
          await fs.symlink(cache.target, cache.source, 'dir');
          if (state === 'recreated-source') {
            await fs.unlink(cache.source);
            await fs.mkdir(cache.source);
          } else if (state === 'replaced-target' || state === 'dangling-bridge') {
            await fs.rename(cache.target, cache.target + '.backup');
            if (state === 'replaced-target') await fs.mkdir(cache.target);
          } else await fs.writeFile(cache.journal, 'invalid JSON');
          const oldJournal = await fs.readFile(cache.journal, 'utf8');
          restoreNativeUpdaterCache(cache.source, desktop);
          await fs.mkdir(path.join(cache.source, 'pending'), { recursive: true });
          await fs.writeFile(path.join(cache.source, 'pending', 'update.zip'), 'new-update');
          assert.equal(restoreNativeUpdaterCache(cache.source, desktop), false);
          assert.equal((await fs.lstat(cache.source)).isDirectory(), true);
          assert.equal(await fs.readFile(path.join(cache.source, 'pending', 'update.zip'), 'utf8'), 'new-update');
          assert.equal(await fs.readFile(cache.journal, 'utf8'), oldJournal);
          const retainedCache = state === 'replaced-target' || state === 'dangling-bridge'
            ? cache.target + '.backup' : cache.target;
          assert.equal(await fs.readFile(path.join(retainedCache, 'marker'), 'utf8'), 'retained-update');
          updaterCacheRecoveryStates.push(state);
        }
      }
      const { assertExecutorWorkbenchCompatibility } = await load('workbench-executor-schema');
      const { prepareWorkbenchEnvironment } = await load('workbench-environment');
      const { ComponentUpdateManager, hashComponentPath } = await load('component-update-manager');
      const { executorMigrationLock } = await load('workbench-migration-lock');
      const { isolateDevelopmentEnvironment } = await load('development-isolation');
      const { prepareManagedExecutorEnvironment } = await load('managed-executor-runtime');
      const devHome = path.join(input.root, 'development-fixture');
      const nativeAuth = path.join(devHome, '.codex', 'auth.json');
      await fs.mkdir(path.dirname(nativeAuth), { recursive: true });
      await fs.writeFile(nativeAuth, 'synthetic-development-auth');
      const devEnvironment = {
        HOME: devHome, CODEX_HOME: path.dirname(nativeAuth),
        WEGENT_CODEX_HOME: path.dirname(nativeAuth), WEGENT_EXECUTOR_HOME: devHome,
        WEGENT_WORKBENCH_HOME: devHome, WEWORK_EXECUTOR_PATH: input.executor,
      };
      isolateDevelopmentEnvironment(devEnvironment, {
        packaged: false, packageRoot: path.join(devHome, 'source', 'wework', 'electron'),
        appData: path.join(devHome, 'app-data'), homeDirectory: devHome,
      });
      const devPrepared = await prepareWorkbenchEnvironment({
        environment: devEnvironment, metadata, homeDirectory: devHome,
      });
      prepareManagedExecutorEnvironment({ environment: devPrepared, dataDirectory: devPrepared.WEWORK_USER_DATA_DIR });
      assert.notEqual(devPrepared.WEGENT_CODEX_HOME, path.dirname(nativeAuth));
      const developmentAuth = path.join(devPrepared.WEGENT_CODEX_HOME, 'auth.json');
      if (process.platform === 'win32') {
        assert.equal((await fs.lstat(developmentAuth)).isFile(), true);
        assert.equal(await fs.readFile(developmentAuth, 'utf8'), 'synthetic-development-auth');
      } else {
        assert.equal(await fs.realpath(developmentAuth), nativeAuth);
      }
      assert.equal(devPrepared.WEGENT_CODEX_HOME, path.join(devHome, '.wegent', 'development', 'workbench', 'wework', 'default', 'codex'));
      assert.equal(await fs.readFile(nativeAuth, 'utf8'), 'synthetic-development-auth');
      await assert.rejects(fs.lstat(path.join(devHome, '.wegent', 'workbench')), { code: 'ENOENT' });
      const legacyHome = path.join(input.root, 'legacy-home');
      const legacyExecutor = metadata.weworkExecutorNamespace?.trim()
        ? path.join(legacyHome, '.wework', 'apps', metadata.weworkExecutorNamespace.trim())
        : path.join(legacyHome, '.wework');
      const legacyCodex = path.join(legacyExecutor, 'codex');
      await fs.mkdir(legacyCodex, { recursive: true });
      await fs.writeFile(path.join(legacyCodex, 'auth.json'), 'synthetic-legacy-auth');
      const prepared = prepareWorkbenchEnvironment({
        environment: { HOME: legacyHome, USERPROFILE: legacyHome },
        metadata, homeDirectory: legacyHome,
      });
      assert.notEqual(prepared.WEGENT_CODEX_HOME, legacyCodex);
      await assert.rejects(fs.lstat(prepared.WEGENT_CODEX_HOME), { code: 'ENOENT' });
      assert.equal(await fs.readFile(path.join(legacyCodex, 'auth.json'), 'utf8'), 'synthetic-legacy-auth');
      const home = path.join(input.root, 'must-remain-absent');
      const environment = { PATH: input.path, HOME: home, WEWORK_EXECUTOR_PATH: input.executor };
      await assertExecutorWorkbenchCompatibility(environment);
      const acquireLock = executorMigrationLock(input.executor);
      const lockResources = ['source', 'target', 'state'].map(name => path.join(input.root, 'lock-fixture', name));
      const lock = await acquireLock(lockResources);
      try {
        lock.assertHeld();
        await assert.rejects(acquireLock(lockResources), /lock unavailable/);
      } finally { await lock.release(); }
      const reacquired = await acquireLock(lockResources);
      await reacquired.release();
      await assert.rejects(fs.lstat(home), { code: 'ENOENT' });
      const incompatible = { ...environment, WEWORK_EXECUTOR_PATH: input.incompatibleExecutor };
      await assert.rejects(assertExecutorWorkbenchCompatibility(incompatible), /schema/);
      await assert.rejects(fs.lstat(home), { code: 'ENOENT' });

      const packaged = JSON.parse(await fs.readFile(path.join(input.resources, 'components.json'), 'utf8'));
      const components = Object.fromEntries(Object.entries(packaged.components).map(([id, item]) => [id, {
        version: item.version, contentSha256: item.sha256, archiveSha256: item.sha256,
        archiveBytes: 1, downloadUrl: 'local://packaged-component', entryPath: '.',
      }]));
      const data = path.join(input.root, 'component-state');
      const statePath = path.join(data, 'managed-components', 'state.json');
      await fs.mkdir(path.dirname(statePath), { recursive: true });
      const state = JSON.stringify({ schemaVersion: 1, activationInProgress: true,
        current: { appVersion: packaged.appVersion, components } });
      await fs.writeFile(statePath, state);
      const manager = new ComponentUpdateManager({
        resourcesRoot: input.resources, dataDirectory: data,
        updateBaseUrl: 'http://127.0.0.1:1', currentAppVersion: packaged.appVersion,
        validateExecutor: () => assertExecutorWorkbenchCompatibility(incompatible),
      });
      await assert.rejects(manager.rollbackStartup(), /schema/);
      assert.equal(await fs.readFile(statePath, 'utf8'), state);
      await assert.rejects(manager.prepareStartup(), /schema/);
      assert.equal(await fs.readFile(statePath, 'utf8'), state);

      const incompatibleHash = await hashComponentPath(input.incompatibleExecutor);
      const blobRoot = path.join(data, 'managed-components', 'blobs', 'executor', incompatibleHash);
      await fs.mkdir(blobRoot, { recursive: true });
      await fs.copyFile(input.incompatibleExecutor, path.join(blobRoot, 'executor'));
      const sharedState = JSON.stringify({ schemaVersion: 1, current: {
        appVersion: packaged.appVersion, components: { ...components, executor: {
          ...components.executor, contentSha256: incompatibleHash,
          archiveSha256: incompatibleHash, entryPath: 'executor',
        } },
      } });
      await fs.writeFile(statePath, sharedState);
      const fallbackManager = new ComponentUpdateManager({
        resourcesRoot: input.resources, dataDirectory: data,
        updateBaseUrl: 'http://127.0.0.1:1', currentAppVersion: packaged.appVersion,
        validateExecutor: selected => assertExecutorWorkbenchCompatibility({
          ...environment, WEWORK_EXECUTOR_PATH: selected,
        }),
      });
      const fallbackPaths = await fallbackManager.prepareStartup();
      assert.equal(fallbackPaths.executor, path.join(input.resources, packaged.components.executor.path));
      await fallbackManager.confirmStartup();
      assert.equal(await fallbackManager.rollbackStartup(), false);
      assert.equal(await fs.readFile(statePath, 'utf8'), sharedState);
      await assert.rejects(fs.lstat(home), { code: 'ENOENT' });
      process.stdout.write(JSON.stringify({
        compatibleExecutorAccepted: true,
        nativeFileLockMutualExclusion: true,
        incompatibleExecutorRejectedBeforeHomeWrites: true,
        incompatibleComponentRollbackRejected: true,
        interruptedStartupRollbackRejected: true,
        selectedComponentStateUnchanged: true,
        packagedFallbackPreservesSharedComponentIndex: true,
        developmentHomeIsolatedWithNativeAuthLink: true,
        legacyHomeUntouched: true,
        updaterCacheRecoveryStates,
      }));
      app.exit(0);
    })().catch(error => { console.error(error.stack); app.exit(1); });
  `
  const scriptPath = join(root, 'verify.cjs')
  await writeFile(scriptPath, script)
  const environment = { ...appEnvironment }
  delete environment.ELECTRON_RUN_AS_NODE
  // Packaged executables always launch their own app; use the matching Electron toolchain
  // to import the packaged modules with real Electron APIs available.
  const electronBinary = resolveElectronBinary()
  const { stdout } = await promisify(execFile)(
    electronBinary,
    [scriptPath, JSON.stringify(input), ...resolveElectronLaunchArguments()],
    {
      env: environment,
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    }
  )
  const evidence = JSON.parse(stdout)
  if (macosLogStartup) evidence.macosLogStartup = macosLogStartup
  evidence.missingDesktopUserData = missingDesktopUserData
  if (windowsDesktopDataStartup) evidence.windowsDesktopDataStartup = windowsDesktopDataStartup
  if (windowsComponentPublication)
    evidence.windowsComponentPublication = windowsComponentPublication
  assert.equal(evidence.selectedComponentStateUnchanged, true)
  if (process.platform === 'darwin') {
    assert.deepEqual(evidence.updaterCacheRecoveryStates, [
      'recreated-source',
      'replaced-target',
      'dangling-bridge',
      'invalid-journal',
    ])
  }
  await writeFile(join(root, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  return evidence
}
