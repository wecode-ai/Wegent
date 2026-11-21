// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/plugins/installed/{installed_id}/download`.
//!
//! Source: `app/api/endpoints/installed_plugins.py::download_installed_plugin`
//! (router `APIRouter(tags=["plugins"])` mounted at `/plugins`), with the
//! `security.get_current_user_jwt_apikey_tasktoken` dependency.
//!
//! Session topology of the recorded dependency sequence: the authentication
//! helper commits its `last_used_at` write, reloads the two expired ORM rows
//! on the same connection, and that connection closes with a `ROLLBACK`; the
//! endpoint then resolves the package on a second connection, ending with its
//! own `ROLLBACK`. The recreation keeps that split: [`authenticate`] uses the
//! pooled statement path and rolls its write back, and [`resolve_package`]
//! reads inside one request transaction.
//!
//! Behavior:
//! 1. `verify_api_key`: the personal `api_keys` row by SHA-256 hash (expiry and
//!    key-type checks), its active owner, then
//!    `last_used_at = datetime.utcnow()` + `db.commit()`, after which the
//!    expired ORM objects are reloaded by primary key (the trailing
//!    `logger.debug` f-string reads `api_key_record.name` and `user.user_name`).
//! 2. `plugin_marketplace_service.release_package_for_install`: `_owned_install`
//!    (404 `Installed plugin not found`), `spec.releaseId` must be an integer,
//!    the release must be `ready` + scan-`passed`, the stored object's SHA-256
//!    must equal `release.sha256` (409 `Plugin package checksum mismatch`), and
//!    the filename is `<slug>-<version>.zip` (or `plugin-<version>.zip` when
//!    the owning plugin row is gone).
//! 3. On that path's `404`, `installed_plugin_service.package_data_for_download`:
//!    the same kind row again, then the first `skill_binaries` row by
//!    `kind_id`; a missing row or empty payload is 404 `Plugin package not
//!    found`, and the filename is the stored `file_name` or
//!    `spec.sourcePayload.filename` (else `<kind name>.zip`).
//!
//! A `PluginPackageStorageError` is the endpoint's 503 `Plugin package storage
//! unavailable`. The response is the raw bytes as `application/zip` with the
//! RFC 5987 `Content-Disposition`.

use brz_http_server::{Binary, HttpResponse, StatusCode};
use brz_mysql::{FromMysqlRow, MysqlResult};
use sha2::{Digest, Sha256};

use crate::http_compat::FastApiError;
use crate::plugins_marketplace::db::PLUGIN_COLUMNS;
use crate::state::AppState;
use wegent_backend_persistence::mysql_query::MysqlQuery;
use wegent_storage::minio_client;
use wegent_storage::plugin_package::plugin_storage_config;

/// `app.core.auth_utils.API_KEY_PREFIX`.
const API_KEY_PREFIX: &str = "wg-";
/// `KEY_TYPE_PERSONAL` (`app.models.api_key`).
const KEY_TYPE_PERSONAL: &str = "personal";

/// `db.query(APIKey)`'s labeled full-entity projection (`find_valid_api_key`).
const API_KEY_COLUMNS: &str = "api_keys.id AS api_keys_id, \
     api_keys.user_id AS api_keys_user_id, api_keys.key_hash AS api_keys_key_hash, \
     api_keys.key_prefix AS api_keys_key_prefix, api_keys.name AS api_keys_name, \
     api_keys.key_type AS api_keys_key_type, api_keys.description AS api_keys_description, \
     api_keys.expires_at AS api_keys_expires_at, api_keys.last_used_at AS api_keys_last_used_at, \
     api_keys.is_active AS api_keys_is_active, api_keys.created_at AS api_keys_created_at, \
     api_keys.updated_at AS api_keys_updated_at";

/// `db.query(User)`'s labeled full-entity projection.
const USER_COLUMNS: &str = "users.id AS users_id, users.user_name AS users_user_name, \
     users.password_hash AS users_password_hash, users.email AS users_email, \
     users.git_info AS users_git_info, users.is_active AS users_is_active, \
     users.`role` AS users_role, users.auth_source AS users_auth_source, \
     users.preferences AS users_preferences, users.created_at AS users_created_at, \
     users.updated_at AS users_updated_at";

/// `db.query(Kind)`'s labeled full-entity projection.
const KIND_COLUMNS: &str = "kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, kinds.namespace AS kinds_namespace, \
     kinds.json AS kinds_json, kinds.is_active AS kinds_is_active, \
     kinds.created_at AS kinds_created_at, kinds.updated_at AS kinds_updated_at";

/// `db.query(SkillBinary)`'s labeled full-entity projection.
const SKILL_BINARY_COLUMNS: &str = "skill_binaries.id AS skill_binaries_id, \
     skill_binaries.kind_id AS skill_binaries_kind_id, \
     skill_binaries.binary_data AS skill_binaries_binary_data, \
     skill_binaries.file_size AS skill_binaries_file_size, \
     skill_binaries.file_hash AS skill_binaries_file_hash, \
     skill_binaries.type AS skill_binaries_type, \
     skill_binaries.file_name AS skill_binaries_file_name, \
     skill_binaries.created_at AS skill_binaries_created_at";

/// `db.get(PluginRelease, release_id)`'s labeled projection.
const RELEASE_COLUMNS: &str = "plugin_releases.id AS plugin_releases_id, \
     plugin_releases.plugin_id AS plugin_releases_plugin_id, \
     plugin_releases.version AS plugin_releases_version, \
     plugin_releases.storage_key AS plugin_releases_storage_key, \
     plugin_releases.sha256 AS plugin_releases_sha256, \
     plugin_releases.size_bytes AS plugin_releases_size_bytes, \
     plugin_releases.status AS plugin_releases_status, \
     plugin_releases.scan_status AS plugin_releases_scan_status";

/// The verified caller of one download request.
///
/// An API-key request defers the post-commit ORM reloads: the source's commit
/// expires `api_key_record` and `user`, and the drawing `logger.debug`
/// f-string reads them on the *endpoint's* session, so the endpoint transaction
/// opens with those two reloads before its own work.
#[derive(Debug)]
pub struct DownloadUser {
    pub user_id: i64,
    /// `api_keys.id` when the request authenticated with an API key.
    api_key_id: Option<i64>,
}

/// An authentication rejection. A dependency failure is not a credential
/// problem: the source's unhandled-failure handler renders it as a 500.
enum AuthRejection {
    MissingCredentials,
    InvalidApiKey,
    InvalidCredentials,
    UserNotActivated,
    Dependency,
}

type AuthResult<T> = Result<T, AuthRejection>;

impl AuthRejection {
    fn invalid_api_key() -> Self {
        Self::InvalidApiKey
    }

    fn invalid_credentials() -> Self {
        Self::InvalidCredentials
    }

    fn missing_credentials() -> Self {
        Self::MissingCredentials
    }

    fn into_error(self) -> FastApiError {
        match self {
            Self::MissingCredentials => FastApiError::detail(
                StatusCode::UNAUTHORIZED,
                "Missing authentication credentials",
            ),
            Self::InvalidApiKey => {
                FastApiError::detail(StatusCode::UNAUTHORIZED, "Invalid or expired API key")
            }
            Self::InvalidCredentials => {
                FastApiError::detail(StatusCode::UNAUTHORIZED, "Could not validate credentials")
            }
            Self::UserNotActivated => {
                FastApiError::detail(StatusCode::UNAUTHORIZED, "User not activated")
            }
            Self::Dependency => FastApiError::unhandled(),
        }
    }
}

/// One active `InstalledPlugin` kind row (`_owned_install`).
#[derive(Debug, FromMysqlRow)]
struct KindRecord {
    #[mysql(rename = "kinds_id")]
    id: i64,
    #[mysql(rename = "kinds_name")]
    name: String,
    #[mysql(rename = "kinds_json")]
    json: brz_mysql::Json<brz_json::OpaqueJson>,
}

/// The `plugin_releases` row `db.get(PluginRelease, release_id)` returns.
#[derive(Debug, FromMysqlRow)]
struct ReleaseRecord {
    #[mysql(rename = "plugin_releases_plugin_id")]
    plugin_id: i64,
    #[mysql(rename = "plugin_releases_version")]
    version: String,
    #[mysql(rename = "plugin_releases_storage_key")]
    storage_key: String,
    #[mysql(rename = "plugin_releases_sha256")]
    sha256: String,
    #[mysql(rename = "plugin_releases_status")]
    status: String,
    #[mysql(rename = "plugin_releases_scan_status")]
    scan_status: String,
}

/// `db.get(Plugin, release.plugin_id)`: only `slug` names the download.
#[derive(Debug, FromMysqlRow)]
struct PluginSlugRow {
    #[mysql(rename = "plugins_slug")]
    slug: String,
}

/// The first `skill_binaries` row of one kind.
#[derive(Debug, FromMysqlRow)]
struct SkillBinaryRow {
    /// A nullable blob column: a SQL NULL must not abort the handler.
    #[mysql(rename = "skill_binaries_binary_data")]
    binary_data: Option<Vec<u8>>,
    #[mysql(rename = "skill_binaries_file_name")]
    file_name: Option<String>,
}

/// `api_keys` row of `find_valid_api_key`.
#[derive(Debug, FromMysqlRow)]
struct ApiKeyRecord {
    #[mysql(rename = "api_keys_id")]
    id: i64,
    #[mysql(rename = "api_keys_user_id")]
    user_id: i64,
    #[mysql(rename = "api_keys_name")]
    #[allow(dead_code)]
    name: String,
    #[mysql(rename = "api_keys_expires_at")]
    expires_at: Option<chrono::NaiveDateTime>,
}

/// `users` row of `verify_api_key`'s owner read.
#[derive(Debug, FromMysqlRow)]
struct OwnerRecord {
    #[mysql(rename = "users_id")]
    id: i64,
    #[mysql(rename = "users_user_name")]
    #[allow(dead_code)]
    user_name: String,
    #[mysql(rename = "users_is_active")]
    is_active: bool,
}

const DOWNLOAD_MISSING: &str = "Wegent-Installed-Download-Missing";
const DOWNLOAD_INVALID_API_KEY: &str = "Wegent-Installed-Download-Invalid-Api-Key";
const DOWNLOAD_USER_NOT_ACTIVATED: &str = "Wegent-Installed-Download-User-Not-Activated";

impl brz_http_server::Authenticator<DownloadUser> for crate::auth::AppAuthenticator {
    async fn authenticate<'a>(
        &'a self,
        request: brz_http_server::AuthRequest<'a>,
    ) -> Result<DownloadUser, brz_http_server::AuthFailure> {
        let authorization = request
            .header("authorization")
            .and_then(|value| std::str::from_utf8(value).ok());
        let x_api_key = request
            .header("x-api-key")
            .and_then(|value| std::str::from_utf8(value).ok());
        let headers = crate::headers::OwnedHeaders::from_pairs([
            ("authorization", authorization),
            ("x-api-key", x_api_key),
        ]);
        let state = self.state();
        authenticate(&state.auth, &state.mysql, &headers.view())
            .await
            .map_err(|rejection| match rejection {
                AuthRejection::MissingCredentials => {
                    brz_http_server::AuthFailure::missing_credentials(DOWNLOAD_MISSING)
                }
                AuthRejection::InvalidApiKey => {
                    brz_http_server::AuthFailure::invalid_credentials(DOWNLOAD_INVALID_API_KEY)
                }
                AuthRejection::UserNotActivated => {
                    brz_http_server::AuthFailure::invalid_credentials(DOWNLOAD_USER_NOT_ACTIVATED)
                }
                AuthRejection::Dependency => brz_http_server::AuthFailure::Internal,
                AuthRejection::InvalidCredentials => {
                    brz_http_server::AuthFailure::invalid_credentials("Bearer")
                }
            })
    }

    fn api_log_id<'a>(&'a self, _principal: &'a DownloadUser) -> Option<&'a dyn std::fmt::Display> {
        None
    }

    fn reject(
        &self,
        _request: brz_http_server::AuthRequest<'_>,
        failure: brz_http_server::AuthFailure,
        arena: &brz_http_server::EphemeralBytesArena,
    ) -> brz_http_server::Response {
        use brz_http_server::IntoHttpError as _;
        let error = match failure {
            brz_http_server::AuthFailure::MissingCredentials {
                challenge: DOWNLOAD_MISSING,
            } => AuthRejection::missing_credentials().into_error(),
            brz_http_server::AuthFailure::InvalidCredentials {
                challenge: DOWNLOAD_INVALID_API_KEY,
            } => AuthRejection::invalid_api_key().into_error(),
            brz_http_server::AuthFailure::InvalidCredentials {
                challenge: DOWNLOAD_USER_NOT_ACTIVATED,
            } => FastApiError::detail(StatusCode::UNAUTHORIZED, "User not activated"),
            brz_http_server::AuthFailure::Internal | brz_http_server::AuthFailure::Unavailable => {
                FastApiError::unhandled()
            }
            _ => AuthRejection::invalid_credentials().into_error(),
        };
        error.into_http_error(arena)
    }
}

/// GET /api/plugins/installed/{installed_id}/download.
#[brz_http_server::get("/api/plugins/installed/:installed_id/download")]
async fn download_installed_plugin(
    #[inject(state)] state: &AppState,
    #[auth] user: DownloadUser,
    installed_id: i64,
) -> Result<HttpResponse<Binary>, FastApiError> {
    let package = resolve_package(state, &user, installed_id).await;
    let (bytes, filename) = match package {
        Ok(package) => package,
        Err(error) => return Err(error),
    };

    let encoded = percent_encode(&filename);
    let content_disposition = format!("attachment; filename*=UTF-8''{encoded}");
    HttpResponse::new(Binary::new(bytes))
        .header("content-type", "application/zip")
        .map_err(header_error)?
        .header("content-disposition", &content_disposition)
        .map_err(header_error)
}

fn header_error(error: brz_http_server::HeaderBlockError) -> FastApiError {
    FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
}

/// `get_current_user_jwt_apikey_tasktoken`, in its source priority order.
async fn authenticate(
    auth: &crate::config::AuthConfig,
    mysql: &brz_mysql::MysqlService,
    headers: &impl crate::headers::Headers,
) -> AuthResult<DownloadUser> {
    if let Some(api_key) = headers
        .header("x-api-key")
        .map(str::trim)
        .filter(|value| !value.is_empty() && is_api_key(value))
    {
        return verify_api_key(mysql, api_key).await;
    }
    let Some(credential) = bearer_credential(headers) else {
        return Err(AuthRejection::missing_credentials());
    };
    if is_api_key(&credential) {
        return verify_api_key(mysql, &credential).await;
    }
    verify_session_user(auth, mysql, &credential).await
}

/// `verify_api_key` plus the post-commit ORM reloads and the session's
/// trailing `ROLLBACK`.
async fn verify_api_key(
    mysql: &brz_mysql::MysqlService,
    api_key: &str,
) -> AuthResult<DownloadUser> {
    let key_hash = format!("{:x}", Sha256::digest(api_key.as_bytes()));
    let record: Option<ApiKeyRecord> = mysql
        .fetch_optional(
            format!(
                "SELECT {API_KEY_COLUMNS} \nFROM api_keys \n\
                 WHERE api_keys.key_hash = '{key_hash}' \
                 AND api_keys.key_type = '{KEY_TYPE_PERSONAL}' \
                 AND api_keys.is_active = true \n LIMIT 1"
            ),
            (),
        )
        .await
        .map_err(|error| dependency_rejection("api key lookup", error))?;
    let Some(record) = record else {
        return Err(AuthRejection::invalid_api_key());
    };
    if record
        .expires_at
        .is_some_and(|expires_at| expires_at < chrono::Utc::now().naive_utc())
    {
        return Err(AuthRejection::invalid_api_key());
    }
    let owner: Option<OwnerRecord> = mysql
        .fetch_optional(
            format!(
                "SELECT {USER_COLUMNS} \nFROM users \nWHERE users.id = {} \n LIMIT 1",
                record.user_id
            ),
            (),
        )
        .await
        .map_err(|error| dependency_rejection("api key lookup", error))?;
    let Some(owner) = owner else {
        return Err(AuthRejection::invalid_api_key());
    };
    if !owner.is_active {
        return Err(AuthRejection::invalid_api_key());
    }

    // `api_key_record.last_used_at = datetime.utcnow(); db.commit()`.
    let now = chrono::Utc::now()
        .naive_utc()
        .format("%Y-%m-%d %H:%M:%S%.6f")
        .to_string();
    mysql
        .execute(
            format!(
                "UPDATE api_keys SET last_used_at='{now}', updated_at=now() \
                 WHERE api_keys.id = {}",
                record.id
            ),
            (),
        )
        .await
        .map_err(|error| dependency_rejection("api key update", error))?;
    mysql
        .execute("COMMIT", ())
        .await
        .map_err(|error| dependency_rejection("api key commit", error))?;

    // The commit expires both ORM objects; the trailing `logger.debug`
    // f-string reads `api_key_record.name` and `user.user_name`, so both rows
    // are re-selected by primary key before the session closes.
    let _: Option<ApiKeyRecord> = mysql
        .fetch_optional(
            format!(
                "SELECT {API_KEY_COLUMNS} \nFROM api_keys \nWHERE api_keys.id = {}",
                record.id
            ),
            (),
        )
        .await
        .map_err(|error| dependency_rejection("api key reload", error))?;
    let _: Option<OwnerRecord> = mysql
        .fetch_optional(
            format!(
                "SELECT {USER_COLUMNS} \nFROM users \nWHERE users.id = {}",
                owner.id
            ),
            (),
        )
        .await
        .map_err(|error| dependency_rejection("user reload", error))?;
    // `db.close()` on the dependency's own session.
    let _ = mysql.execute("ROLLBACK", ()).await;

    Ok(DownloadUser {
        user_id: owner.id,
        api_key_id: None,
    })
}

/// The user-session JWT branch: decode the token, then load the active user by
/// `user_name` (`verify_jwt_token_with_db`).
async fn verify_session_user(
    auth: &crate::config::AuthConfig,
    mysql: &brz_mysql::MysqlService,
    token: &str,
) -> AuthResult<DownloadUser> {
    let user_name = crate::auth::decode_session_claims(auth, token)
        .and_then(|claims| claims.username())
        .ok_or_else(AuthRejection::invalid_credentials)?;
    let owner: Option<OwnerRecord> = mysql
        .fetch_optional(
            format!("SELECT {USER_COLUMNS} \nFROM users \nWHERE users.user_name = ? \n LIMIT 1"),
            (user_name.as_str(),),
        )
        .await
        .map_err(|error| dependency_rejection("session user lookup", error))?;
    let Some(owner) = owner else {
        return Err(AuthRejection::invalid_credentials());
    };
    if !owner.is_active {
        return Err(AuthRejection::UserNotActivated);
    }
    Ok(DownloadUser {
        user_id: owner.id,
        api_key_id: None,
    })
}

/// `release_package_for_install`, falling back to `package_data_for_download`
/// on its 404s. A 409 checksum mismatch and the 503 storage failures
/// propagate unchanged.
async fn resolve_package(
    state: &AppState,
    user: &DownloadUser,
    installed_id: i64,
) -> Result<(Vec<u8>, String), FastApiError> {
    let mut session = &state.mysql;
    if let Some(api_key_id) = user.api_key_id {
        // The commit in `verify_api_key` expired both ORM objects; the
        // endpoint session re-selects them by primary key before its own work
        // (`logger.debug` reading `api_key_record.name`/`user.user_name`).
        let _: Option<ApiKeyRecord> = session
            .fetch_optional(
                format!(
                    "SELECT {API_KEY_COLUMNS} \nFROM api_keys \nWHERE api_keys.id = {api_key_id}"
                ),
                (),
            )
            .await
            .map_err(dependency_error)?;
        let _: Option<OwnerRecord> = session
            .fetch_optional(
                format!(
                    "SELECT {USER_COLUMNS} \nFROM users \nWHERE users.id = {}",
                    user.user_id
                ),
                (),
            )
            .await
            .map_err(dependency_error)?;
    }
    let user_id = user.user_id;
    let installed = owned_install(&mut session, user_id, installed_id)
        .await
        .map_err(dependency_error)?;
    let Some(installed) = installed else {
        return Err(not_found("Installed plugin not found"));
    };
    let outcome = match release_package_for_install(&mut session, state, &installed)
        .await
        .map_err(dependency_error)?
    {
        Ok(package) => Ok(package),
        Err(ReleaseFailure::Unavailable) => {
            package_data_for_download(&mut session, user_id, installed_id)
                .await
                .map_err(dependency_error)?
        }
        Err(ReleaseFailure::Checksum) => Err(FastApiError::detail(
            StatusCode::CONFLICT,
            "Plugin package checksum mismatch",
        )),
        Err(ReleaseFailure::Storage) => Err(FastApiError::detail(
            StatusCode::SERVICE_UNAVAILABLE,
            "Plugin package storage unavailable",
        )),
    };
    // The endpoint session's `db.close()`: SQLAlchemy rolls back the idle
    // transaction the request session opened.
    let _ = state.mysql.execute("ROLLBACK", ()).await;
    outcome
}

/// Why `release_package_for_install` had no package.
enum ReleaseFailure {
    /// The source's `404`: the endpoint retries the `skill_binaries` fallback.
    Unavailable,
    /// The source's `409` checksum mismatch.
    Checksum,
    /// `PluginPackageStorageError` -> 503.
    Storage,
}

/// `release_package_for_install`.
async fn release_package_for_install<Q: MysqlQuery>(
    session: &mut Q,
    state: &AppState,
    installed: &KindRecord,
) -> MysqlResult<Result<(Vec<u8>, String), ReleaseFailure>> {
    let json = installed.json.0.to_value();
    let release_id = json
        .get("spec")
        .and_then(|spec| spec.get("releaseId"))
        .and_then(serde_json::Value::as_i64);
    let Some(release_id) = release_id else {
        return Ok(Err(ReleaseFailure::Unavailable));
    };
    let release: Option<ReleaseRecord> = session
        .fetch_optional(
            format!(
                "SELECT {RELEASE_COLUMNS} FROM plugin_releases \
                 WHERE plugin_releases.id = {release_id}"
            ),
            (),
        )
        .await?;
    let Some(release) = release else {
        return Ok(Err(ReleaseFailure::Unavailable));
    };
    if release.status != "ready" || release.scan_status != "passed" {
        return Ok(Err(ReleaseFailure::Unavailable));
    }

    let config = plugin_storage_config();
    let package =
        match minio_client::get_object(&state.attachment_http, &config, &release.storage_key).await
        {
            Ok(bytes) => bytes,
            Err(_) => return Ok(Err(ReleaseFailure::Storage)),
        };
    let actual = format!("{:x}", Sha256::digest(&package));
    if actual != release.sha256 {
        return Ok(Err(ReleaseFailure::Checksum));
    }

    let plugin: Option<PluginSlugRow> = session
        .fetch_optional(
            format!(
                "SELECT {PLUGIN_COLUMNS} FROM plugins WHERE plugins.id = {}",
                release.plugin_id
            ),
            (),
        )
        .await?;
    let slug = plugin
        .map(|row| row.slug)
        .unwrap_or_else(|| "plugin".to_string());
    Ok(Ok((package, format!("{slug}-{}.zip", release.version))))
}

/// `_owned_install`: the caller's active `InstalledPlugin` kind.
async fn owned_install<Q: MysqlQuery>(
    session: &mut Q,
    user_id: i64,
    installed_id: i64,
) -> MysqlResult<Option<KindRecord>> {
    session
        .fetch_optional(
            format!(
                "SELECT {KIND_COLUMNS} FROM kinds WHERE kinds.id = {installed_id} \
                 AND kinds.user_id = {user_id} AND kinds.kind = 'InstalledPlugin' \
                 AND kinds.namespace = 'default' AND kinds.is_active = 1 \n LIMIT 1"
            ),
            (),
        )
        .await
}

/// `installed_plugin_service.package_data_for_download`.
async fn package_data_for_download<Q: MysqlQuery>(
    session: &mut Q,
    user_id: i64,
    installed_id: i64,
) -> MysqlResult<Result<(Vec<u8>, String), FastApiError>> {
    // `_get_active_installed_plugin`: the same filter rendered with `true`.
    let Some(row) = session
        .fetch_optional::<_, _, KindRecord>(
            format!(
                "SELECT {KIND_COLUMNS} FROM kinds WHERE kinds.id = {installed_id} \
                 AND kinds.user_id = {user_id} AND kinds.kind = 'InstalledPlugin' \
                 AND kinds.namespace = 'default' AND kinds.is_active = true \n LIMIT 1"
            ),
            (),
        )
        .await?
    else {
        return Ok(Err(not_found("Installed plugin not found")));
    };
    let Some(package) = session
        .fetch_optional::<_, _, SkillBinaryRow>(
            format!(
                "SELECT {SKILL_BINARY_COLUMNS} FROM skill_binaries \
                 WHERE skill_binaries.kind_id = {} \n LIMIT 1",
                row.id
            ),
            (),
        )
        .await?
    else {
        return Ok(Err(not_found("Plugin package not found")));
    };
    let Some(binary_data) = package.binary_data else {
        return Ok(Err(not_found("Plugin package not found")));
    };
    let filename = match package.file_name {
        Some(name) if !name.is_empty() => name,
        _ => fallback_filename(&row),
    };
    Ok(Ok((binary_data, filename)))
}

/// `_fallback_filename`: `spec.sourcePayload.filename`, else `<name>.zip`.
fn fallback_filename(row: &KindRecord) -> String {
    let json = row.json.0.to_value();
    let filename = json
        .get("spec")
        .and_then(|spec| spec.get("sourcePayload"))
        .and_then(|payload| payload.get("filename"))
        .and_then(serde_json::Value::as_str)
        .filter(|name| !name.is_empty());
    filename
        .map(str::to_string)
        .unwrap_or_else(|| format!("{}.zip", row.name))
}

fn not_found(detail: &str) -> FastApiError {
    FastApiError::detail(StatusCode::NOT_FOUND, detail)
}

fn dependency_rejection(operation: &'static str, error: brz_mysql::MysqlError) -> AuthRejection {
    tracing::error!(%error, operation, "installed plugin download authentication failed");
    AuthRejection::Dependency
}

fn dependency_error(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "installed plugin download dependency failure");
    FastApiError::unhandled()
}

/// `is_api_key`: the `wg-` prefix selects the API-key branch.
fn is_api_key(token: &str) -> bool {
    token.starts_with(API_KEY_PREFIX)
}

/// The `Authorization` header's bearer credential
/// (`extract_authorization_token`: `Bearer xxx` or the plain value).
fn bearer_credential(headers: &impl crate::headers::Headers) -> Option<String> {
    let value = headers.header("authorization")?.trim();
    let token = match value.split_once(' ') {
        Some((scheme, token)) if scheme.eq_ignore_ascii_case("bearer") => token.trim(),
        _ => value,
    };
    (!token.is_empty()).then(|| token.to_string())
}

/// RFC 5987 percent-encoding for the `Content-Disposition` filename.
fn percent_encode(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(value.len());
    for &byte in value.as_bytes() {
        let unreserved = byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~');
        if unreserved {
            out.push(byte as char);
        } else {
            out.push('%');
            out.push(HEX[(byte >> 4) as usize] as char);
            out.push(HEX[(byte & 0xF) as usize] as char);
        }
    }
    out
}

#[cfg(test)]
#[path = "download_tests.rs"]
mod tests;
