---
sidebar_position: 35
---

# Skill asset publication and binding migration

External Skill sources own instructions, scripts, and resources. Backend stores
ordinary Skill ZIPs. Executor uses the standard download API and content hashes
to link selected packages into each execution's private snapshot. Agent Home
and session history remain shared. Publishing a package does not change running
executions. Device images no longer install a document-specific Skill tree.

## Document catalog upgrade

`backend/skill_catalogs/document.json` is release configuration, not a runtime
dependency protocol. It publishes the Chat-only `document` asset and ordinary
native `docx`, `xlsx`, `pptx`, and `pdf` assets. Obtain complete, reviewed source
packages from the Skill marketplace or repository and pin their release versions.
The `chat` source root must contain the original Chat `document/` including its
provider and tools. The `native` root must contain all four complete format
directories, including scripts and resources.

Use the target Backend database configuration during the release maintenance window:

```bash
cd backend
uv run python scripts/publish_skill_catalog.py skill_catalogs/document.json \
  --source chat=/release/chat-skills \
  --source native=/release/native-skills
```

The default validates and rolls back. Review the database identity, asset IDs,
and affected bindings, then add `--apply` with the same source packages. Use
`--env-file /release/backend.env` for an explicit configuration file. Fresh
environments run normal resource initialization first, then the same catalog
publication. Existing environments must also run this step. Requests never fetch
external repositories, and publication never modifies the source directories.

Publication reuses Skill validation and storage, preserves public IDs, and
migrates exact Ghost, SkillBinding, InstalledSkill, and Template references in
one transaction. Private namesakes, existing destination bindings, exceptions,
forced preload, and disabled state are preserved. Automatic bindings select
compatible Skills for the actual Shell; explicit incompatible selections still
fail. Chat retains its original provider and sandbox tools.
User and group SkillBindings use the names addressed by existing management APIs,
so settings, removal, and restoration keep working. Earlier `catalog-*` bindings
are renamed in place. An existing canonical destination retains its settings and
supersedes an old alias. Group destinations are shared across creators to prevent
duplicate bindings.

Explicit Chat Ghost preloads remain unchanged. Native-only Ghost and template
document preloads become compatible format preloads. A Ghost sharing a forced
document preload across Chat and native Shells causes the entire transaction to
roll back with its ID. Split that explicit preload before publishing; do not
ignore the error. Back up affected Skill ZIPs and Kind JSON first. Rolling back
application code does not restore database packages or bindings.

## Verification

Focused tests cover fresh publication, upgrades, rollback, idempotence, private
namesakes, disabled bindings, and preloads. The existing `claude-runtime` desktop
E2E uploads two versions of ordinary format Skills and checks complete resources,
shared Home, and isolated execution configuration and Skill snapshots. GitHub
`wework-e2e.yml` runs this scenario, including settings, removal, and restoration
of migrated bindings through the standard API.
