---
sidebar_position: 25
---

# Rust MySQL database migrations

The Rust Backend prepares MySQL before starting background consumers and HTTP handlers. Development startup retains `ENVIRONMENT=development` and `DB_AUTO_MIGRATE=true`. Production checks the version and reports pending migrations without applying them.

## Versions and assets

The runner retains `alembic_version.version_num`, historical revision IDs, and branch/merge semantics. Multiple rows represent the current branch heads. Unknown revisions fail rather than being silently stamped.

Fresh databases use the complete current structure in `backend-rs/migrations/schema.json` and are stamped only after successful creation. Existing databases apply pending revisions in dependency order. Create the database itself beforehand, as with Python.

Revision assets live under `backend-rs/migrations/revisions/` and are embedded through `src/migrations/assets.rs`. SQL steps can declare schema predicates; Rust modules implement historical query-dependent data transformations. Runtime migration does not invoke Python or Alembic.

Original Alembic scripts and legacy Wiki SQL live under `backend-rs/migrations/reference/` for Python-only operation and compatibility comparisons. Rust does not load those Python scripts.

### Business writes and generated columns

The shared project-row writer reads writable columns from MySQL metadata. Both ordinary and idempotent inserts exclude columns with a nonempty `GENERATION_EXPRESSION`, leaving their values to the database. Explicitly inserting NULL into a generated column is invalid even when it is nullable: MySQL returns error 3105 and rolls back the task-claim transaction. Nullable `public_id`, `project_key`, and `storage_prefix` values remain NULL so records without identifiers do not collide on unique keys. This write-path fix does not change the schema or require a migration.

## Commands

From `backend-rs`, using the development database configuration:

```bash
cargo run -- db validate
cargo run -- --env-file ../backend/.env db status
cargo run -- --env-file ../backend/.env db upgrade
cargo run -- --env-file ../backend/.env db downgrade -1
cargo run -- --env-file ../backend/.env db downgrade REVISION
cargo run -- --env-file ../backend/.env db init
```

`db init` honors the initialization switches and does not create tables.

For each new schema change, add a revision and its parents, register its embedded asset, and update the complete current schema and its revision. Keep applied migration files immutable. Verify business-data conversions along with DDL changes.

MySQL DDL may commit implicitly. A migration failure stops startup but cannot guarantee rollback of successful DDL. Its revision is not advanced. Inspect the error and partial structure before repairing; do not stamp past the failing migration.

Historical downgrade restrictions are retained. A database created from current models is not equivalent to replaying every historical migration; crossing early foreign-key revisions during downgrade can fail with duplicate constraints, as in the Python implementation. Graph reachability does not guarantee lossless downgrade of every database.


Migration connections are separate from request pools, use at most one connection, and allow a one-hour driver budget per migration callback. They close after initialization.

## Initialization ownership

Canonical resources live in `backend-rs/init_data/`. Initialization retains `INIT_DATA_ENABLED`, `INIT_DATA_FORCE`, `INIT_DATA_DIR`, public resource identities, existing-resource preservation, versioned built-in Skill updates, and initial administrator password setup state. Extensions may register additional resource directories. Prebuilt binaries resolve local `init_data/` from the runtime working directory rather than a build-machine path. The hybrid launcher changes into `backend-rs/`; set `INIT_DATA_DIR` and `BUILTIN_PLUGINS_DIR` when launching from another directory.

The hybrid launcher starts Rust database preparation before the Python upstream. It sets `DB_INITIALIZATION_OWNER=rust` in Python to prevent duplicate initialization. Standalone Python debugging retains its existing initialization ownership. Packaged resources remain at `/app/init_data`.

Startup retains Python's `wegent:startup_lock` with a 120-second expiry. A process that cannot acquire it skips initialization; no additional multi-instance queue is introduced.

## Verification

The existing Rust CI MySQL service runs isolated migration checks:

```bash
WEGENT_TEST_MYSQL_ADDRESS=127.0.0.1:3306 cargo test --lib migrations::mysql_tests -- --ignored --nocapture
```

The fixture creates and deletes only its own temporary schema. Graph and resource parsing tests run with ordinary `cargo test`.

### Historical-data regressions and recovery boundaries

The native MySQL suite reuses the existing CI MySQL and Redis services and runs isolated schemas serially to avoid multiplying concurrent database connections and DDL workloads. It covers historical pre-marketplace tables with populated Team/Skill installation statistics, runtime/workspace conversion, collaboration grants and assignment events, pending plugin submissions, integer IDs and member uniqueness, built-in staging through ZIP packaging and marketplace publication, and Rust startup locking and lock release after migration failure. Later migrations are tested by downgrading the structure to their parent revision, inserting legacy business data, and applying native upgrades and downgrades. This does not certify every one of the 65 possible historical starting points.

Unbound SQLAlchemy parameters are rejected during plan preflight. Other SQL or connection failures can still occur after implicit MySQL DDL commits. An unchanged revision does not prove that structural changes rolled back: do not blindly retry or manually stamp past a failure. Stop the service, inspect the failed revision's actual tables and indexes, and restore a backup or perform reviewed cleanup of that revision's partial structures before upgrading again. Downgrades can discard data in new structures and do not replace backup restoration.

This PR does not record or substitute for human database-migration approval. Before running against a local development database whose data must be retained, confirm the service-stop window, backup and tested restoration, failure handling, and applicable rollback boundaries. Production use requires separate review.
