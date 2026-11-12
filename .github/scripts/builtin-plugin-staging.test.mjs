import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  builtinPluginStagingDefinitions,
  stageBuiltinPlugin,
} from "../../scripts/builtin-plugin-staging.mjs";

test("both built-ins stage into the packaged Rust initialization directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "wegent-plugin-staging-"));
  try {
    for (const definition of builtinPluginStagingDefinitions) {
      const source = join(root, "source", definition.name);
      await mkdir(join(source, ".codex-plugin"), { recursive: true });
      const manifest = {
        name: definition.name,
        version: "1.0.0",
        description: "fixture",
      };
      await writeFile(
        join(source, ".codex-plugin/plugin.json"),
        JSON.stringify(manifest),
      );
      assert.equal(
        await stageBuiltinPlugin(definition, {
          sourceRoot: source,
          required: true,
          workspaceRoot: root,
        }),
        true,
      );
      const staged = join(
        root,
        "backend-rs/init_data/plugins",
        definition.name,
        ".codex-plugin/plugin.json",
      );
      assert.deepEqual(JSON.parse(await readFile(staged, "utf8")), manifest);
      await assert.rejects(
        readFile(
          join(
            root,
            "backend/init_data/plugins",
            definition.name,
            ".codex-plugin/plugin.json",
          ),
        ),
      );
    }
    const recipe = await readFile(
      new URL("../../docker/standalone/Dockerfile", import.meta.url),
      "utf8",
    );
    assert.match(recipe, /COPY backend-rs\/init_data \/app\/init_data/);
    const ignores = await readFile(
      new URL("../../.gitignore", import.meta.url),
      "utf8",
    );
    for (const { name } of builtinPluginStagingDefinitions)
      assert.ok(ignores.includes(`backend-rs/init_data/plugins/${name}/`));
    await assert.rejects(
      stageBuiltinPlugin(builtinPluginStagingDefinitions[0], {
        sourceRoot: join(root, "missing"),
        required: true,
        workspaceRoot: root,
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
