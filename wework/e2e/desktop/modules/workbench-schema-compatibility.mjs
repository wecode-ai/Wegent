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
  const macosLogStartup =
    process.platform === 'darwin'
      ? await verifyMacosLogStartup({
          resources: input.resources,
          executor: input.executor,
          environment: appEnvironment,
          root: join(root, 'macos-log-startup'),
        })
      : undefined
  const windowsDesktopDataStartup =
    process.platform === 'win32'
      ? await verifyWindowsDesktopDataStartup({
          resources: input.resources,
          executor: input.executor,
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
      const { migrateWorkbenchDesktopData, prepareDesktopDataSource } = await load('workbench-desktop-data');
      const { packagedUpdaterCache, restoreNativeUpdaterCache } = await load('../host/app-update-cache');
      const updaterCacheRecoveryStates = [];
      if (metadata.weworkProductName) app.setName(metadata.weworkProductName);
      if (process.platform === 'darwin') {
        const logs = app.getPath('logs');
        assert.equal(logs, path.join(input.root, 'Library', 'Logs', metadata.weworkProductName || app.getName()));
        const updaterCache = packagedUpdaterCache(input.root, input.resources, {}, 'darwin');
        assert.equal(path.dirname(updaterCache), path.join(input.root, 'Library', 'Caches'));
        const migration = { source: path.join(input.root, 'legacy-user-data'), desktop: path.join(input.root, 'desktop'), logs };
        await fs.mkdir(updaterCache, { recursive: true });
        await fs.writeFile(path.join(updaterCache, 'marker'), 'before-upgrade');
        prepareDesktopDataSource(migration.source, migration.desktop);
        migrateWorkbenchDesktopData(migration);
        const journal = path.join(migration.desktop, 'migrations', 'desktop-updater-cache-v1.json');
        migrateWorkbenchDesktopData(migration);
        await assert.rejects(fs.lstat(journal), { code: 'ENOENT' });
        assert.equal((await fs.lstat(updaterCache)).isDirectory(), true);
        assert.equal(await fs.readFile(path.join(updaterCache, 'marker'), 'utf8'), 'before-upgrade');
        const { migrateWorkbenchDataEntry } = await load('workbench-data-migration');
        for (const state of ['recreated-source', 'replaced-target', 'dangling-bridge', 'invalid-journal']) {
          const fixtureRoot = path.join(input.root, 'updater-cache-recovery', state);
          const desktop = path.join(fixtureRoot, 'desktop');
          const cache = { source: path.join(fixtureRoot, 'system-cache'),
            target: path.join(desktop, 'updater-cache'),
            journal: path.join(desktop, 'migrations', 'desktop-updater-cache-v1.json') };
          await fs.mkdir(cache.source, { recursive: true });
          await fs.writeFile(path.join(cache.source, 'marker'), 'retained-update');
          migrateWorkbenchDataEntry(cache);
          if (state === 'recreated-source') {
            await fs.unlink(cache.source);
            await fs.mkdir(cache.source);
          } else if (state === 'replaced-target' || state === 'dangling-bridge') {
            await fs.rename(cache.target, cache.target + '.backup');
            if (state === 'replaced-target') await fs.mkdir(cache.target);
          } else await fs.writeFile(cache.journal, 'invalid JSON');
          const oldJournal = await fs.readFile(cache.journal, 'utf8');
          const persistent = { source: path.join(fixtureRoot, 'user-data'), desktop,
            logs: path.join(fixtureRoot, 'user-data', 'logs') };
          prepareDesktopDataSource(persistent.source, desktop);
          await fs.writeFile(path.join(persistent.source, 'preferences.json'), 'original-preferences');
          const migrated = migrateWorkbenchDesktopData(persistent);
          restoreNativeUpdaterCache(cache.source, desktop);
          await fs.mkdir(path.join(cache.source, 'pending'), { recursive: true });
          await fs.writeFile(path.join(cache.source, 'pending', 'update.zip'), 'new-update');
          migrateWorkbenchDesktopData(persistent);
          assert.equal(restoreNativeUpdaterCache(cache.source, desktop), false);
          assert.equal((await fs.lstat(cache.source)).isDirectory(), true);
          assert.equal(await fs.readFile(path.join(cache.source, 'pending', 'update.zip'), 'utf8'), 'new-update');
          assert.equal(await fs.readFile(path.join(migrated.userData, 'preferences.json'), 'utf8'), 'original-preferences');
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
      const freshHome = path.join(input.root, 'empty-codex-home');
      const freshExecutorHome = metadata.weworkExecutorNamespace?.trim()
        ? path.join(freshHome, '.wework', 'apps', metadata.weworkExecutorNamespace.trim())
        : path.join(freshHome, '.wework');
      await fs.mkdir(path.join(freshExecutorHome, 'codex'), { recursive: true });
      const freshPrepared = await prepareWorkbenchEnvironment({
        environment: { HOME: freshHome, USERPROFILE: freshHome, PATH: input.path,
          SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
          WEWORK_EXECUTOR_PATH: input.executor },
        metadata, homeDirectory: freshHome,
      });
      assert.notEqual(freshPrepared.WEGENT_CODEX_HOME, path.join(freshExecutorHome, 'codex'));
      assert.equal(await fs.realpath(path.join(freshExecutorHome, 'codex')), await fs.realpath(freshPrepared.WEGENT_CODEX_HOME));
      assert.deepEqual(await fs.readdir(freshPrepared.WEGENT_CODEX_HOME), []);
      const upgradeHome = path.join(input.root, 'populated-legacy-codex-home');
      const upgradeExecutorHome = metadata.weworkExecutorNamespace?.trim()
        ? path.join(upgradeHome, '.wework', 'apps', metadata.weworkExecutorNamespace.trim())
        : path.join(upgradeHome, '.wework');
      const legacyCodexHome = path.join(upgradeExecutorHome, 'codex');
      const config = "cli_auth_credentials_store = 'file'\\n";
      await fs.mkdir(path.join(legacyCodexHome, 'sessions'), { recursive: true });
      await fs.writeFile(path.join(legacyCodexHome, 'config.toml'), config);
      await fs.writeFile(path.join(legacyCodexHome, 'auth.json'), 'synthetic-upgrade-auth');
      await fs.writeFile(path.join(legacyCodexHome, 'sessions', 'marker'), 'legacy-session');
      await fs.writeFile(path.join(upgradeExecutorHome, 'device-config.json'), '{"marker":"legacy-device"}');
      await fs.writeFile(path.join(upgradeExecutorHome, 'device-config.json.lock'), '');
      const { DatabaseSync } = require('node:sqlite');
      const seedPath = path.join(upgradeHome, 'seed.sqlite');
      const seed = new DatabaseSync(seedPath);
      seed.exec("PRAGMA journal_mode=WAL; CREATE TABLE tasks(id TEXT); INSERT INTO tasks VALUES ('legacy-task')");
      await fs.mkdir(path.join(upgradeExecutorHome, 'data'), { recursive: true });
      for (const suffix of ['', '-wal', '-shm'])
        await fs.copyFile(seedPath + suffix, path.join(upgradeExecutorHome, 'data', 'tasks.sqlite') + suffix);
      seed.close();
      const upgradeOptions = {
        environment: { HOME: upgradeHome, USERPROFILE: upgradeHome, PATH: input.path,
          SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
          WEWORK_EXECUTOR_PATH: input.executor },
        metadata, homeDirectory: upgradeHome,
      };
      const upgraded = await prepareWorkbenchEnvironment(upgradeOptions);
      assert.notEqual(upgraded.WEGENT_CODEX_HOME, legacyCodexHome);
      assert.equal(await fs.realpath(legacyCodexHome), await fs.realpath(upgraded.WEGENT_CODEX_HOME));
      assert.equal(await fs.readFile(path.join(upgraded.WEGENT_CODEX_HOME, 'config.toml'), 'utf8'), config);
      assert.equal(await fs.readFile(path.join(upgraded.WEGENT_CODEX_HOME, 'auth.json'), 'utf8'), 'synthetic-upgrade-auth');
      assert.equal(await fs.readFile(path.join(upgraded.WEGENT_CODEX_HOME, 'sessions', 'marker'), 'utf8'), 'legacy-session');
      const upgradedDatabase = new DatabaseSync(path.join(upgraded.WEGENT_EXECUTOR_HOME, 'data', 'tasks.sqlite'));
      assert.equal(upgradedDatabase.prepare('SELECT id FROM tasks').get().id, 'legacy-task');
      upgradedDatabase.exec("INSERT INTO tasks VALUES ('new-task')");
      upgradedDatabase.close();
      const legacyDatabase = new DatabaseSync(path.join(upgradeExecutorHome, 'data', 'tasks.sqlite'));
      assert.equal(legacyDatabase.prepare('SELECT count(*) AS total FROM tasks').get().total, 2);
      legacyDatabase.close();
      const replacementConfig = path.join(upgradeHome, 'replacement-device-config.json');
      await fs.writeFile(replacementConfig, '{"marker":"updated-device"}');
      await fs.rename(replacementConfig, path.join(upgraded.WEGENT_EXECUTOR_HOME, 'device-config.json'));
      await prepareWorkbenchEnvironment(upgradeOptions);
      assert.equal(await fs.readFile(path.join(upgradeExecutorHome, 'device-config.json'), 'utf8'), '{"marker":"updated-device"}');
      if (process.platform === 'win32') {
        // Reproduce an installation that already completed migration with a file hard link.
        const source = path.join(freshExecutorHome, 'app-ipc.addr');
        const target = path.join(freshPrepared.WEGENT_EXECUTOR_HOME, 'app-ipc.addr');
        const state = path.join(freshPrepared.WEGENT_EXECUTOR_HOME, 'migrations', 'executor-data-v1');
        const journal = path.join(state, Buffer.from('app-ipc.addr').toString('hex') + '.json');
        await fs.writeFile(target, 'synthetic-ipc-address');
        await fs.link(target, source);
        const identity = await fs.stat(target, { bigint: true });
        const record = JSON.stringify({ source, target, journal, version: 1, directory: false,
          completed: true, device: identity.dev.toString(), inode: identity.ino.toString() });
        await fs.writeFile(journal, record);
        await fs.writeFile(path.join(state, 'entries.json'), JSON.stringify(['app-ipc.addr']));
        for (let restart = 0; restart < 2; restart++) {
          await prepareWorkbenchEnvironment({
            environment: { HOME: freshHome, USERPROFILE: freshHome, PATH: input.path,
              SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
              WEWORK_EXECUTOR_PATH: input.executor },
            metadata, homeDirectory: freshHome,
          });
          assert.equal(await fs.readFile(journal, 'utf8'), record);
          assert.equal(await fs.readFile(source, 'utf8'), 'synthetic-ipc-address');
          assert.equal((await fs.stat(source, { bigint: true })).ino, identity.ino);
        }
      }
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
      await assert.rejects(prepareWorkbenchEnvironment({
        environment: incompatible, metadata, homeDirectory: home,
      }), /schema/);
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
        emptyCodexHomeMigratedWithoutCredentials: true,
        completedFileHardlinksPreserved: process.platform === 'win32' ? true : undefined,
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
