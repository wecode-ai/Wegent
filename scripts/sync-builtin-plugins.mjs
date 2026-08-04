#!/usr/bin/env node

import {
  builtinPluginStagingDefinitions,
  stageBuiltinPlugin,
} from "./builtin-plugin-staging.mjs";

for (const definition of builtinPluginStagingDefinitions) {
  await stageBuiltinPlugin(definition);
}
