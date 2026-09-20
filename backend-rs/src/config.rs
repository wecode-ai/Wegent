// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Application configuration loaded from the source-compatible environment.
//!
//! Ported from the reference implementation's `src/config.rs`. The source reads
//! these values through `app.core.config.settings` (pydantic `BaseSettings`)
//! from the process environment and a dotenv file. The target reads the same
//! names with dotenv-compatible parsing, preferring the process environment.
//! The dotenv file defaults to `config/example.env` and is redirected with
//! `WEGENT_BACKEND_RS_ENV_FILE`.
//!
//! [`init_env`] ports the reference's `init_env`: it exports the dotenv entries
//! the process environment does not already define, so modules that read
//! `env::var` directly observe the same configuration as [`env_or_dotenv`].
//! `env::set_var` is `unsafe` in edition 2024 because it races with concurrent
//! environment reads in other threads, so the crate level lint is `deny` and
//! [`init_env`] carries the single `allow`. The caller must invoke it before
//! the process spawns any thread.

use std::env;
use std::sync::OnceLock;

/// JWT configuration (`settings.SECRET_KEY`,
/// `settings.JWT_LEGACY_SECRET_KEYS`, `settings.ALGORITHM`).
#[derive(Debug, Clone)]
pub struct AuthConfig {
    /// Active JWT signing key.
    pub jwt_key: String,
    /// Legacy decode-only keys (may be empty).
    pub legacy_jwt_keys: Vec<String>,
    /// JWT algorithm name (`HS256`).
    pub algorithm: String,
}

/// Database configuration (`DATABASE_URL` and optional `DATABASE_SLAVE_URL`).
#[derive(Debug, Clone)]
pub struct DatabaseConfig {
    /// Raw source-compatible `mysql+pymysql://...` URL.
    pub url: String,
    /// Optional read-only database URL. Missing and blank values use master.
    pub slave_url: Option<String>,
}

/// Errors while resolving configuration.
#[derive(Debug)]
pub enum ConfigError {
    /// A required variable is missing or empty.
    Missing(&'static str),
    /// A required variable is present but malformed.
    Invalid(&'static str),
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Missing(name) => write!(formatter, "{name} is required"),
            Self::Invalid(name) => write!(formatter, "{name} is invalid"),
        }
    }
}

impl std::error::Error for ConfigError {}

/// Applies dotenv value semantics: strip one pair of matching outer quotes.
fn dotenv_value(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.len() >= 2 {
        let bytes = trimmed.as_bytes();
        let first = bytes[0];
        let last = bytes[bytes.len() - 1];
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            return trimmed[1..trimmed.len() - 1].to_string();
        }
    }
    trimmed.to_string()
}

/// Default dotenv path, relative to the process working directory. Both
/// backends ship `config/example.env`, so a run from the crate root (or from
/// the container's `/app`) resolves it without configuration.
const DEFAULT_ENV_FILE: &str = "config/example.env";

/// The dotenv path chosen at startup by [`init_env_file`]; unset until then.
static ENV_FILE: OnceLock<String> = OnceLock::new();

/// Environment variable that redirects the dotenv file. Crate-owned name for
/// the reference's `WEGENT_ENV_FILE`.
const ENV_FILE_VAR: &str = "WEGENT_BACKEND_RS_ENV_FILE";

/// Resolves the dotenv path: `--env-file`, then `WEGENT_BACKEND_RS_ENV_FILE`,
/// then the default.
///
/// A blank value is treated as absent, so an empty argument or an
/// exported-but-empty variable does not silently disable the next source.
fn resolve_env_file(flag: Option<String>, from_env: Option<String>) -> String {
    [flag, from_env]
        .into_iter()
        .flatten()
        .find(|path| !path.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_ENV_FILE.to_string())
}

/// Reads `--env-file <path>` (also `--env-file=<path>`) from an argument list.
fn env_file_arg(mut args: impl Iterator<Item = String>) -> Option<String> {
    while let Some(argument) = args.next() {
        if let Some(value) = argument.strip_prefix("--env-file=") {
            return Some(value.to_string());
        }
        if argument == "--env-file" {
            return args.next();
        }
    }
    None
}

/// Chooses the dotenv path for this process from the command line and the
/// environment.
///
/// Call once at startup, before any configuration is read. Later calls are
/// ignored, and a process that never calls it still resolves the path on
/// demand.
pub fn init_env_file() {
    let _ = ENV_FILE.set(resolve_env_file(
        env_file_arg(env::args().skip(1)),
        env::var(ENV_FILE_VAR).ok(),
    ));
}

/// The dotenv file consulted when a variable is absent from the process
/// environment.
fn dotenv_path() -> String {
    ENV_FILE
        .get()
        .cloned()
        .unwrap_or_else(|| resolve_env_file(None, env::var(ENV_FILE_VAR).ok()))
}

/// Parses a dotenv file into its `(name, value)` entries, dropping blank
/// lines, comments, lines without `=`, and entries with a blank value.
fn dotenv_entries(content: &str) -> Vec<(String, String)> {
    content
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            let (key, raw_value) = line.split_once('=')?;
            let value = dotenv_value(raw_value);
            if value.is_empty() {
                return None;
            }
            Some((key.trim().to_owned(), value))
        })
        .collect()
}

/// Looks up one key in a dotenv file's contents.
fn read_dotenv(content: &str, name: &str) -> Option<String> {
    dotenv_entries(content)
        .into_iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value)
}

/// Selects the dotenv entries to export into the process environment: every
/// entry whose name the process environment does not already define.
fn missing_dotenv_entries(content: &str, is_set: impl Fn(&str) -> bool) -> Vec<(String, String)> {
    dotenv_entries(content)
        .into_iter()
        .filter(|(name, _)| !is_set(name))
        .collect()
}

/// Reports whether the process environment defines a non-blank value, matching
/// the precedence [`env_or_dotenv`] applies.
fn is_process_env_set(name: &str) -> bool {
    env::var(name).is_ok_and(|value| !value.trim().is_empty())
}

/// Exports the dotenv entries the process environment does not already define,
/// mirroring the reference `init_env`.
///
/// Resolves the dotenv path first, so a caller that only needs exported values
/// does not have to know about [`init_env_file`]. The process environment wins,
/// so an injected configuration such as a container's `REDIS_URL` is never
/// overwritten by the dotenv file. A blank environment value counts as absent,
/// matching [`env_or_dotenv`].
///
/// # Safety contract
///
/// `env::set_var` is `unsafe` in edition 2024 because it races with concurrent
/// environment reads; call this before the process spawns any thread — in
/// particular before a Tokio runtime is built.
#[allow(unsafe_code)]
pub fn init_env() {
    init_env_file();
    let Ok(content) = std::fs::read_to_string(dotenv_path()) else {
        return;
    };
    for (name, value) in missing_dotenv_entries(&content, is_process_env_set) {
        // SAFETY: single-threaded by the caller contract documented above.
        unsafe { env::set_var(name, value) };
    }
}

/// Reads one variable from the process environment, falling back to the
/// dotenv file at [`dotenv_path`].
///
/// A blank process-environment value is treated as absent, matching the
/// source's pydantic settings precedence where an empty value does not
/// override the dotenv default.
#[must_use]
pub fn env_or_dotenv(name: &str) -> Option<String> {
    if let Ok(value) = env::var(name)
        && !value.trim().is_empty()
    {
        return Some(value);
    }
    let content = std::fs::read_to_string(dotenv_path()).ok()?;
    read_dotenv(&content, name)
}

/// Reads an optional setting while allowing an explicitly blank process value
/// to disable a value present in the dotenv file.
#[must_use]
pub fn optional_env_or_dotenv(name: &str) -> Option<String> {
    match env::var(name) {
        Ok(value) => (!value.trim().is_empty()).then(|| value.trim().to_owned()),
        Err(_) => {
            let content = std::fs::read_to_string(dotenv_path()).ok()?;
            read_dotenv(&content, name)
        }
    }
}

/// Splits `JWT_LEGACY_SECRET_KEYS` the way the source does: a
/// comma-separated list whose blank entries are dropped. Deduplication
/// against the active key happens in [`crate::auth`].
fn parse_legacy_keys(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(str::to_string)
        .collect()
}

impl AuthConfig {
    /// Reads the source-compatible JWT configuration.
    ///
    /// The active key falls back to the pydantic default because the source
    /// does not fail startup when it is absent.
    #[must_use]
    pub fn from_env() -> Self {
        let jwt_key = env_or_dotenv("SECRET_KEY").unwrap_or_else(|| "secret-key".to_string());
        let legacy_jwt_keys = env_or_dotenv("JWT_LEGACY_SECRET_KEYS")
            .map(|value| parse_legacy_keys(&value))
            .unwrap_or_default();
        let algorithm = env_or_dotenv("ALGORITHM").unwrap_or_else(|| "HS256".to_string());
        Self {
            jwt_key,
            legacy_jwt_keys,
            algorithm,
        }
    }
}

impl DatabaseConfig {
    /// Reads the source-compatible `DATABASE_URL`.
    ///
    /// # Errors
    ///
    /// Returns [`ConfigError::Missing`] when `DATABASE_URL` is neither in the
    /// process environment nor in the dotenv file.
    pub fn from_env() -> Result<Self, ConfigError> {
        let url = env_or_dotenv("DATABASE_URL").ok_or(ConfigError::Missing("DATABASE_URL"))?;
        let slave_url = optional_env_or_dotenv("DATABASE_SLAVE_URL");
        Ok(Self { url, slave_url })
    }

    /// Converts the SQLAlchemy `mysql+pymysql://` scheme to the plain
    /// `mysql://` scheme used by the target driver.
    ///
    /// The source driver (PyMySQL via SQLAlchemy) does not negotiate TLS by
    /// default, so the target also connects in plaintext: `ssl-mode=disabled`
    /// keeps the driver default (`Preferred`) from upgrading the connection to
    /// TLS when the server offers it.
    #[must_use]
    pub fn mysql_url(&self) -> String {
        mysql_driver_url(&self.url)
    }

    /// Converts the optional slave URL to SQLx syntax.
    #[must_use]
    pub fn mysql_slave_url(&self) -> Option<String> {
        self.slave_url.as_deref().map(mysql_driver_url)
    }
}

fn mysql_driver_url(url: &str) -> String {
    let base = if let Some(rest) = url.strip_prefix("mysql+pymysql://") {
        format!("mysql://{rest}")
    } else {
        url.to_owned()
    };
    match base.split_once('?') {
        Some((_head, query)) if query.contains("ssl-mode=") => base,
        Some((head, query)) => format!("{head}?{query}&ssl-mode=disabled"),
        None => format!("{base}?ssl-mode=disabled"),
    }
}

/// Redis configuration (`settings.REDIS_URL`, `redis://:secret@host:port/db`).
#[derive(Debug, Clone)]
pub struct RedisConfig {
    /// Hostname from the URL authority.
    pub host: String,
    /// Port from the URL authority (default 6379).
    pub port: u16,
    /// Database index (default 0).
    pub db: i64,
    /// Password when the URL carries one.
    #[allow(dead_code)]
    pub password: Option<String>,
    /// Optional read-only endpoint. Missing and blank values use master.
    pub slave: Option<RedisSlaveConfig>,
}

#[derive(Debug, Clone)]
pub struct RedisSlaveConfig {
    pub host: String,
    pub port: u16,
    pub db: i64,
}

/// `ACCESS_TOKEN_EXPIRE_MINUTES` default (`app.core.config`: 7 days).
pub(crate) const ACCESS_TOKEN_EXPIRE_MINUTES_DEFAULT: i64 = 7 * 24 * 60;

/// Read `ACCESS_TOKEN_EXPIRE_MINUTES` (minutes, default 7 days).
pub(crate) fn env_access_token_expire_minutes() -> i64 {
    env_or_dotenv("ACCESS_TOKEN_EXPIRE_MINUTES")
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(ACCESS_TOKEN_EXPIRE_MINUTES_DEFAULT)
}

impl RedisConfig {
    /// Read and parse the source-compatible `REDIS_URL`
    /// (`redis://[:password@]host:port[/db]`).
    pub fn from_env() -> Result<Self, ConfigError> {
        let url = env_or_dotenv("REDIS_URL").ok_or(ConfigError::Missing("REDIS_URL"))?;
        Self::from_urls(&url, optional_env_or_dotenv("REDIS_SLAVE_URL").as_deref())
    }

    pub(crate) fn from_urls(
        master_url: &str,
        slave_url: Option<&str>,
    ) -> Result<Self, ConfigError> {
        let mut config = Self::parse_named(master_url, "REDIS_URL")?;
        if let Some(slave_url) = slave_url {
            let slave = Self::parse_named(slave_url, "REDIS_SLAVE_URL")?;
            if slave.password != config.password || slave.db != config.db {
                return Err(ConfigError::Invalid("REDIS_SLAVE_URL"));
            }
            config.slave = Some(RedisSlaveConfig {
                host: slave.host,
                port: slave.port,
                db: slave.db,
            });
        }
        Ok(config)
    }

    fn parse_named(url: &str, name: &'static str) -> Result<Self, ConfigError> {
        let invalid = || ConfigError::Invalid(name);
        let rest = url.strip_prefix("redis://").ok_or_else(invalid)?;
        // Split the optional path (database index) off the authority.
        let (authority, path) = match rest.split_once('/') {
            Some((authority, path)) => (authority, path),
            None => (rest, ""),
        };
        let (userinfo, hostport) = match authority.rsplit_once('@') {
            Some((userinfo, hostport)) => (Some(userinfo), hostport),
            None => (None, authority),
        };
        let password = userinfo
            .map(|info| match info.split_once(':') {
                // The username is empty by convention (`redis://:pass@host`).
                Some((_user, password)) => password.to_string(),
                None => info.to_string(),
            })
            .filter(|password| !password.is_empty());
        let (host, port) = match hostport.rsplit_once(':') {
            Some((host, port)) => (host, port.parse::<u16>().map_err(|_| invalid())?),
            None => (hostport, 6379),
        };
        if host.is_empty() {
            return Err(invalid());
        }
        let db = if path.is_empty() {
            0
        } else {
            path.parse::<i64>().map_err(|_| invalid())?
        };
        Ok(Self {
            host: host.to_string(),
            port,
            db,
            password,
            slave: None,
        })
    }

    #[must_use]
    pub fn endpoint(&self) -> String {
        format!("{}:{}:{}", self.host, self.port, self.db)
    }

    #[must_use]
    pub fn slave_endpoint(&self) -> Option<String> {
        self.slave
            .as_ref()
            .map(|slave| format!("{}:{}:{}", slave.host, slave.port, slave.db))
    }
}

/// OIDC settings used by `GET /api/auth/oidc/callback`.
#[derive(Debug, Clone)]
pub struct OidcConfig {
    /// Source `OIDC_STATE_SECRET_KEY` (state JWT signing key).
    pub state_key: String,
    /// Source `OIDC_STATE_EXPIRE_SECONDS` (default 600).
    // source-compatible settings field
    #[allow(dead_code)]
    pub state_expire_seconds: i64,
    /// Source `OIDC_DISCOVERY_URL`.
    pub discovery_url: String,
    /// Source `OIDC_CLIENT_ID`.
    // source-compatible settings field
    #[allow(dead_code)]
    pub client_id: String,
    /// Source `OIDC_CLIENT_SECRET`.
    // source-compatible settings field
    #[allow(dead_code)]
    pub client_secret: String,
    /// Source `OIDC_REDIRECT_URI`.
    // source-compatible settings field
    #[allow(dead_code)]
    pub redirect_uri: String,
    /// Source `FRONTEND_URL`.
    pub frontend_url: String,
}

impl Default for OidcConfig {
    fn default() -> Self {
        Self {
            state_key: "test".to_string(),
            state_expire_seconds: 600,
            discovery_url: "http://localhost:5556/.well-known/openid-configuration".to_string(),
            client_id: "wegent".to_string(),
            client_secret: "test".to_string(),
            redirect_uri: "http://localhost:8000/api/auth/oidc/callback".to_string(),
            frontend_url: "http://localhost:3000".to_string(),
        }
    }
}

impl OidcConfig {
    /// Reads the source-compatible configuration with pydantic's field
    /// defaults as fallbacks, mirroring `Settings` in `app/core/config.py`.
    pub fn from_env() -> Self {
        Self {
            state_key: env_or_dotenv("OIDC_STATE_SECRET_KEY").unwrap_or_else(|| "test".to_string()),
            state_expire_seconds: env_or_dotenv("OIDC_STATE_EXPIRE_SECONDS")
                .and_then(|value| value.parse().ok())
                .unwrap_or(600),
            discovery_url: env_or_dotenv("OIDC_DISCOVERY_URL").unwrap_or_else(|| {
                "http://localhost:5556/.well-known/openid-configuration".to_string()
            }),
            client_id: env_or_dotenv("OIDC_CLIENT_ID").unwrap_or_else(|| "wegent".to_string()),
            client_secret: env_or_dotenv("OIDC_CLIENT_SECRET")
                .unwrap_or_else(|| "test".to_string()),
            redirect_uri: env_or_dotenv("OIDC_REDIRECT_URI")
                .unwrap_or_else(|| "http://localhost:8000/api/auth/oidc/callback".to_string()),
            frontend_url: env_or_dotenv("FRONTEND_URL")
                .unwrap_or_else(|| "http://localhost:3000".to_string()),
        }
    }
}

/// Internal chat storage configuration.
#[derive(Debug, Clone)]
pub struct InternalChatConfig {
    /// `INTERNAL_SERVICE_TOKEN`; endpoints fail closed when unset.
    pub internal_service_token: Option<String>,
    /// `MAX_EXTRACTED_TEXT_LENGTH` (source default 500000).
    pub max_extracted_text_length: usize,
    /// `ATTACHMENT_INJECT_MAX_CHARS` (source default 32000).
    pub attachment_inject_max_chars: usize,
}

impl InternalChatConfig {
    /// Read internal chat storage settings from the environment.
    pub fn from_env() -> Self {
        let internal_service_token = env_or_dotenv("INTERNAL_SERVICE_TOKEN")
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let max_extracted_text_length = env_or_dotenv("MAX_EXTRACTED_TEXT_LENGTH")
            .and_then(|value| value.trim().parse().ok())
            .unwrap_or(500_000);
        let attachment_inject_max_chars = env_or_dotenv("ATTACHMENT_INJECT_MAX_CHARS")
            .and_then(|value| value.trim().parse().ok())
            .unwrap_or(32_000);
        Self {
            internal_service_token,
            max_extracted_text_length,
            attachment_inject_max_chars,
        }
    }
}

/// Default-team configuration (`DEFAULT_TEAM_{MODE}` values, `name#namespace`).
#[derive(Debug, Clone, Default)]
pub struct DefaultTeamsConfig {
    /// Mode -> `name#namespace` raw value, in source iteration order
    /// (`wework`, `chat`, `knowledge`, `code`, `task`).
    pub modes: Vec<(&'static str, String)>,
}

impl DefaultTeamsConfig {
    /// Read the `DEFAULT_TEAM_*` values in source iteration order.
    /// Source defaults for unset variables are preserved (`code` stays empty).
    pub fn from_env() -> Self {
        let modes = [
            (
                "wework",
                env_or_dotenv("DEFAULT_TEAM_WEWORK")
                    .unwrap_or_else(|| "wegent-wework#default".to_string()),
            ),
            (
                "chat",
                env_or_dotenv("DEFAULT_TEAM_CHAT")
                    .unwrap_or_else(|| "wegent-chat#default".to_string()),
            ),
            (
                "knowledge",
                env_or_dotenv("DEFAULT_TEAM_KNOWLEDGE")
                    .unwrap_or_else(|| "wegent-notebook#default".to_string()),
            ),
            (
                "code",
                env_or_dotenv("DEFAULT_TEAM_CODE").unwrap_or_default(),
            ),
            (
                "task",
                env_or_dotenv("DEFAULT_TEAM_TASK")
                    .unwrap_or_else(|| "wegent-wework#default".to_string()),
            ),
        ];
        Self {
            modes: modes.to_vec(),
        }
    }

    /// Parse the non-empty entries into `(mode, name, namespace)` triples
    /// (`_get_default_teams_config`).
    pub fn parsed(&self) -> Vec<(&'static str, String, String)> {
        let mut parsed = Vec::new();
        for (mode, value) in &self.modes {
            let value = value.trim();
            if value.is_empty() {
                continue;
            }
            let (name, namespace) = match value.split_once('#') {
                Some((name, namespace)) => (name.trim(), namespace.trim().to_string()),
                None => (value, "default".to_string()),
            };
            if !name.is_empty() {
                parsed.push((*mode, name.to_string(), namespace));
            }
        }
        parsed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_the_sqlalchemy_scheme_and_disables_tls() {
        let config = DatabaseConfig {
            url: "mysql+pymysql://user:pw@host:7831/task_manager".to_string(),
            slave_url: None,
        };
        assert_eq!(
            config.mysql_url(),
            "mysql://user:pw@host:7831/task_manager?ssl-mode=disabled"
        );
    }

    #[test]
    fn keeps_an_existing_query_and_an_explicit_ssl_mode() {
        let with_query = DatabaseConfig {
            url: "mysql+pymysql://user:pw@host:7831/db?charset=utf8mb4".to_string(),
            slave_url: None,
        };
        assert_eq!(
            with_query.mysql_url(),
            "mysql://user:pw@host:7831/db?charset=utf8mb4&ssl-mode=disabled"
        );

        let explicit = DatabaseConfig {
            url: "mysql://user:pw@host:7831/db?ssl-mode=required".to_string(),
            slave_url: Some(
                "mysql+pymysql://reader:other@slave:7831/db?charset=utf8mb4".to_string(),
            ),
        };
        assert_eq!(
            explicit.mysql_url(),
            "mysql://user:pw@host:7831/db?ssl-mode=required"
        );
        assert_eq!(
            explicit.mysql_slave_url().as_deref(),
            Some("mysql://reader:other@slave:7831/db?charset=utf8mb4&ssl-mode=disabled")
        );
    }

    #[test]
    fn redis_slave_must_share_password_and_database() {
        let config = RedisConfig::from_urls(
            "redis://:secret@master:6379/2",
            Some("redis://:secret@slave:6380/2"),
        )
        .unwrap();
        assert_eq!(config.endpoint(), "master:6379:2");
        assert_eq!(config.slave_endpoint().as_deref(), Some("slave:6380:2"));

        assert!(matches!(
            RedisConfig::from_urls(
                "redis://:secret@master:6379/2",
                Some("redis://:other@slave:6379/2")
            ),
            Err(ConfigError::Invalid("REDIS_SLAVE_URL"))
        ));
        assert!(matches!(
            RedisConfig::from_urls(
                "redis://:secret@master:6379/2",
                Some("redis://:secret@slave:6379/3")
            ),
            Err(ConfigError::Invalid("REDIS_SLAVE_URL"))
        ));
    }

    #[test]
    fn strips_one_pair_of_matching_quotes() {
        assert_eq!(dotenv_value("'abc'"), "abc");
        assert_eq!(dotenv_value("\"abc\""), "abc");
        assert_eq!(dotenv_value("  abc  "), "abc");
        assert_eq!(dotenv_value("'abc\""), "'abc\"");
        assert_eq!(dotenv_value("\"abc"), "\"abc");
        assert_eq!(dotenv_value(""), "");
    }

    #[test]
    fn unset_variables_have_no_dotenv_value() {
        assert_eq!(env_or_dotenv("WEGENT_BACKEND_RS_TEST_UNSET_VARIABLE"), None);
    }

    #[test]
    fn env_file_precedence_is_flag_then_variable_then_default() {
        assert_eq!(
            resolve_env_file(Some("flag.env".to_owned()), Some("var.env".to_owned())),
            "flag.env"
        );
        assert_eq!(
            resolve_env_file(None, Some("var.env".to_owned())),
            "var.env"
        );
        assert_eq!(resolve_env_file(None, None), DEFAULT_ENV_FILE);
        // A blank value falls through instead of disabling the lookup.
        assert_eq!(
            resolve_env_file(Some("  ".to_owned()), Some("var.env".to_owned())),
            "var.env"
        );
        assert_eq!(
            resolve_env_file(Some(String::new()), None),
            DEFAULT_ENV_FILE
        );
    }

    #[test]
    fn parses_the_env_file_argument() {
        let parse = |args: &[&str]| env_file_arg(args.iter().map(|arg| (*arg).to_owned()));
        assert_eq!(
            parse(&["--env-file", "/tmp/a.env"]),
            Some("/tmp/a.env".to_owned())
        );
        assert_eq!(
            parse(&["--env-file=/tmp/a.env"]),
            Some("/tmp/a.env".to_owned())
        );
        assert_eq!(
            parse(&["--other", "--env-file", "b.env"]),
            Some("b.env".to_owned())
        );
        // A trailing flag without a value is ignored.
        assert_eq!(parse(&["--env-file"]), None);
        assert_eq!(parse(&[]), None);
    }

    #[test]
    fn reads_keys_from_dotenv_contents() {
        let content = "\
# comment
DATABASE_URL=mysql+pymysql://user:pw@host:3306/db
QUOTED='single'
DOUBLE=\"double\"
EMPTY=
SPACED  =  padded
";
        assert_eq!(
            read_dotenv(content, "DATABASE_URL"),
            Some("mysql+pymysql://user:pw@host:3306/db".to_owned())
        );
        assert_eq!(read_dotenv(content, "QUOTED"), Some("single".to_owned()));
        assert_eq!(read_dotenv(content, "DOUBLE"), Some("double".to_owned()));
        assert_eq!(read_dotenv(content, "SPACED"), Some("padded".to_owned()));
        // An empty value is not a value, matching `env_or_dotenv`.
        assert_eq!(read_dotenv(content, "EMPTY"), None);
        assert_eq!(read_dotenv(content, "ABSENT"), None);
    }

    // `init_env` itself mutates the process environment, and the test harness
    // runs tests on multiple threads, so its selection logic is covered here
    // instead; the launcher exercises the export end to end.
    #[test]
    fn dotenv_export_skips_variables_the_process_already_defines() {
        let content = "\
REDIS_URL=redis://127.0.0.1:6379/0
SECRET_KEY='from-file'
EMPTY=
";
        assert_eq!(
            missing_dotenv_entries(content, |_| false),
            vec![
                (
                    "REDIS_URL".to_owned(),
                    "redis://127.0.0.1:6379/0".to_owned()
                ),
                ("SECRET_KEY".to_owned(), "from-file".to_owned()),
            ]
        );
        // A defined variable wins over the file, and blank entries never export.
        let process_env = |name: &str| name == "REDIS_URL";
        assert_eq!(
            missing_dotenv_entries(content, process_env),
            vec![("SECRET_KEY".to_owned(), "from-file".to_owned())]
        );
    }

    #[test]
    fn env_file_variable_name_matches_the_launcher_contract() {
        assert_eq!(ENV_FILE_VAR, "WEGENT_BACKEND_RS_ENV_FILE");
    }

    #[test]
    fn auth_config_splits_legacy_keys() {
        assert_eq!(parse_legacy_keys(" a , ,b, a "), ["a", "b", "a"]);
        assert_eq!(parse_legacy_keys(""), Vec::<String>::new());
    }
}
