import {
  PLUGIN_OPERATION_DEFINITIONS,
  type PluginGeneratedEventMap,
  type PluginOperationKey,
} from './generated/pluginEvents'
import {
  SMART_APP_OPERATION_DEFINITIONS,
  type SmartAppGeneratedEventMap,
  type SmartAppOperationKey,
} from './generated/smartAppEvents'
import {
  STAND_IN_OPERATION_DEFINITIONS,
  type StandInGeneratedEventMap,
  type StandInOperationKey,
} from './generated/standInEvents'

export type DomainGeneratedEventMap = SmartAppGeneratedEventMap &
  PluginGeneratedEventMap &
  StandInGeneratedEventMap
export type DomainOperationKey = SmartAppOperationKey | PluginOperationKey | StandInOperationKey
export const DOMAIN_OPERATION_DEFINITIONS = [
  ...SMART_APP_OPERATION_DEFINITIONS,
  ...PLUGIN_OPERATION_DEFINITIONS,
  ...STAND_IN_OPERATION_DEFINITIONS,
]
