import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { publishedUpgradePolicies } from "../../wework/scripts/lib/published-upgrade-policies.mjs";
import {
  planUpgradeShards,
  upgradeShardSelections,
} from "../../wework/scripts/lib/upgrade-verification-shards.mjs";

const policy = JSON.parse(await readFile("wework/upgrade-policy.json", "utf8"));
const directory = process.env.UPGRADE_PLAN_DIRECTORY;
await mkdir(directory, { recursive: true });
const include = [];
for (const [platform, arch, runner] of [
  ["macos", "arm64", "macos-15"],
  ["windows", "x64", "windows-latest"],
  ["windows", "arm64", "windows-11-arm"],
]) {
  const frozen = planUpgradeShards({
    catalogs: publishedUpgradePolicies({
      repository: process.env.GITHUB_REPOSITORY,
      platform,
      arch,
    }),
    version: process.env.UPGRADE_VERSION,
    channel: process.env.UPGRADE_CHANNEL,
    policy,
    platform,
    arch,
  });
  await writeFile(
    join(directory, `${platform}-${arch}.json`),
    JSON.stringify(frozen) + "\n",
  );
  for (const selection of upgradeShardSelections(frozen))
    include.push({
      platform,
      arch,
      runner,
      channel: selection.channel,
      source_version: selection.source?.version ?? "initial",
    });
}
await appendFile(
  process.env.GITHUB_OUTPUT,
  `matrix=${JSON.stringify({ include })}\n`,
);
