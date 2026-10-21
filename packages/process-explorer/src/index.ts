export type {
  HostProcessDescriptor,
  HostProcessProvider,
  ProcessDegradation,
  ProcessKind,
  ProcessExplorerClient,
  ProcessOwnerRef,
  ProcessRecord,
  ProcessSnapshot,
  ProcessSource,
} from './contract.js'
export {
  buildProcessSnapshot,
  collectDescendantPids,
  defaultKindName,
  defaultOwnerForKind,
  kindFromElectronType,
  type BuildProcessSnapshotInput,
  type ElectronProcessMetric,
  type SystemProcessInfo,
  type WindowProcessInfo,
} from './core/build-snapshot.js'
