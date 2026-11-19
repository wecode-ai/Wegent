// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Count executed reads through the real SDK, independently of statement preparation.
use brz_mysql::{
    FromMysqlRow, Mysql, MysqlArgs, MysqlExecution, MysqlResult, MysqlRouteKey, MysqlRouting,
    MysqlService, MysqlTransactionService,
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use wegent_backend_test_support::unique_database_name;

#[derive(Clone)]
pub(crate) struct ObservedMysql {
    pub mysql: MysqlService,
    reads: Arc<Mutex<Vec<(String, Duration)>>>,
    fail_read_containing: Option<&'static str>,
}

impl ObservedMysql {
    pub fn new(mysql: MysqlService) -> Self {
        Self {
            mysql,
            reads: Arc::default(),
            fail_read_containing: None,
        }
    }

    pub fn take_reads(&self) -> Vec<(String, Duration)> {
        std::mem::take(&mut *self.reads.lock().unwrap())
    }

    pub fn failing(mut self, pattern: &'static str) -> Self {
        self.fail_read_containing = Some(pattern);
        self
    }
}

impl Mysql for ObservedMysql {
    type Transaction = MysqlTransactionService;

    fn with_route<R: MysqlRouting + 'static>(&self, _: R) -> MysqlService {
        panic!("batch reads must use the existing service")
    }

    fn route<K: MysqlRouteKey>(&self, _: K) -> Self {
        self.clone()
    }

    async fn fetch_all<S, A, T>(&self, sql: S, args: A) -> MysqlResult<Vec<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        let start = Instant::now();
        let result = if self
            .fail_read_containing
            .is_some_and(|pattern| sql.as_ref().contains(pattern))
        {
            Err(brz_mysql::MysqlError::InvalidQuery {
                reason: "fixture read failure".into(),
            })
        } else {
            self.mysql.fetch_all(sql.as_ref(), args).await
        };
        self.reads
            .lock()
            .unwrap()
            .push((sql.as_ref().to_string(), start.elapsed()));
        result
    }

    async fn fetch_optional<S, A, T>(&self, sql: S, args: A) -> MysqlResult<Option<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        let start = Instant::now();
        let result = self.mysql.fetch_optional(sql.as_ref(), args).await;
        self.reads
            .lock()
            .unwrap()
            .push((sql.as_ref().to_string(), start.elapsed()));
        result
    }

    async fn execute<S, A>(&self, _: S, _: A) -> MysqlResult<MysqlExecution>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
    {
        panic!("batch response projection must remain read-only")
    }

    async fn fetch_one<S, A, T>(&self, _: S, _: A) -> MysqlResult<T>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        panic!("unexpected fetch_one")
    }

    fn fetch<'a, S, A, T>(
        &'a self,
        _: S,
        _: A,
    ) -> impl futures_util::Stream<Item = MysqlResult<T>> + Send + 'a
    where
        S: AsRef<str> + Send + 'a,
        A: MysqlArgs + Send + 'a,
        T: FromMysqlRow + Send + 'a,
    {
        futures_util::stream::once(async { panic!("unexpected streaming query") })
    }

    async fn with_transaction<T, F>(&self, _: F) -> MysqlResult<T>
    where
        T: Send,
        F: for<'a> AsyncFnOnce(&'a mut Self::Transaction) -> MysqlResult<T> + Send,
    {
        panic!("this fixture must not open a transaction")
    }
}

pub(crate) fn installed_document(id: i64) -> Value {
    json!({
        "metadata": {"name": format!("plugin-{id}"), "namespace": "default"},
        "spec": {"pluginId": id, "releaseId": 10, "source": {"type": "marketplace"}}
    })
}

pub(crate) const CATALOG_SCHEMA: &[&str] = &[
    r#"CREATE TABLE kinds (`id` BIGINT NOT NULL AUTO_INCREMENT, `user_id` BIGINT NOT NULL DEFAULT 0, `kind` VARCHAR(1000) NOT NULL DEFAULT '', `name` VARCHAR(1000) NOT NULL DEFAULT '', `namespace` VARCHAR(1000) NOT NULL DEFAULT '', `json` JSON NOT NULL DEFAULT (JSON_OBJECT()), `is_active` BOOLEAN NOT NULL DEFAULT 0, `created_at` DATETIME NOT NULL DEFAULT '2026-01-01 00:00:00', `updated_at` DATETIME NOT NULL DEFAULT '2026-01-01 00:00:00', PRIMARY KEY (`id`)) ENGINE=InnoDB"#,
    r#"CREATE TABLE plugins (`id` BIGINT NOT NULL DEFAULT 0, `catalog_namespace` VARCHAR(1000) NOT NULL DEFAULT '', `slug` VARCHAR(1000) NOT NULL DEFAULT '', `name` VARCHAR(1000) NOT NULL DEFAULT '', `display_name` VARCHAR(1000) NOT NULL DEFAULT '', `summary` VARCHAR(1000) NOT NULL DEFAULT '', `description_md` VARCHAR(1000) NOT NULL DEFAULT '', `listing_type` VARCHAR(1000) NOT NULL DEFAULT '', `source_type` VARCHAR(1000) NOT NULL DEFAULT '', `source_provider` VARCHAR(1000) NOT NULL DEFAULT '', `owner_user_id` BIGINT NOT NULL DEFAULT 0, `origin_plugin_id` BIGINT NOT NULL DEFAULT 0, `category` VARCHAR(1000) NOT NULL DEFAULT '', `keywords_json` JSON NOT NULL DEFAULT (JSON_OBJECT()), `interface_json` JSON NOT NULL DEFAULT (JSON_OBJECT()), `visibility` VARCHAR(1000) NOT NULL DEFAULT '', `allow_copy` BOOLEAN NOT NULL DEFAULT 0, `status` VARCHAR(1000) NOT NULL DEFAULT '', `latest_release_id` BIGINT NOT NULL DEFAULT 0, `featured_rank` BIGINT NOT NULL DEFAULT 0, `created_at` DATETIME NOT NULL DEFAULT '2026-01-01 00:00:00', `updated_at` DATETIME NOT NULL DEFAULT '2026-01-01 00:00:00', `published_at` DATETIME NOT NULL DEFAULT '2026-01-01 00:00:00', PRIMARY KEY (`id`)) ENGINE=InnoDB"#,
    r#"CREATE TABLE plugin_releases (`id` BIGINT NOT NULL DEFAULT 0, `plugin_id` BIGINT NOT NULL DEFAULT 0, `version` VARCHAR(1000) NOT NULL DEFAULT '', `manifest_json` JSON NOT NULL DEFAULT (JSON_OBJECT()), `interface_json` JSON NOT NULL DEFAULT (JSON_OBJECT()), `release_notes` VARCHAR(1000) NOT NULL DEFAULT '', `storage_key` VARCHAR(1000) NOT NULL DEFAULT '', `sha256` VARCHAR(1000) NOT NULL DEFAULT '', `size_bytes` BIGINT NOT NULL DEFAULT 0, `status` VARCHAR(1000) NOT NULL DEFAULT '', `scan_status` VARCHAR(1000) NOT NULL DEFAULT '', `scan_report_json` JSON NOT NULL DEFAULT (JSON_OBJECT()), `created_by_user_id` BIGINT NOT NULL DEFAULT 0, `publication_revision_id` BIGINT NOT NULL DEFAULT 0, `source_commit_sha` VARCHAR(1000) NOT NULL DEFAULT '', `created_at` DATETIME NOT NULL DEFAULT '2026-01-01 00:00:00', `published_at` DATETIME NOT NULL DEFAULT '2026-01-01 00:00:00', PRIMARY KEY (`id`)) ENGINE=InnoDB"#,
    r#"CREATE TABLE resource_members (`id` BIGINT NOT NULL DEFAULT 0, `resource_type` VARCHAR(1000) NOT NULL DEFAULT '', `resource_id` BIGINT NOT NULL DEFAULT 0, `entity_type` VARCHAR(1000) NOT NULL DEFAULT '', `entity_id` VARCHAR(1000) NOT NULL DEFAULT '', `entity_display_name` VARCHAR(1000) NOT NULL DEFAULT '', `user_id` BIGINT NOT NULL DEFAULT 0, `role` VARCHAR(1000) NOT NULL DEFAULT '', `status` VARCHAR(1000) NOT NULL DEFAULT '', `invited_by_user_id` BIGINT NOT NULL DEFAULT 0, `share_link_id` BIGINT NOT NULL DEFAULT 0, `reviewed_by_user_id` BIGINT NOT NULL DEFAULT 0, `reviewed_at` DATETIME NOT NULL DEFAULT '2026-01-01 00:00:00', `copied_resource_id` BIGINT NOT NULL DEFAULT 0, `requested_at` DATETIME NOT NULL DEFAULT '2026-01-01 00:00:00', `created_at` DATETIME NOT NULL DEFAULT '2026-01-01 00:00:00', `updated_at` DATETIME NOT NULL DEFAULT '2026-01-01 00:00:00', PRIMARY KEY (`id`)) ENGINE=InnoDB"#,
    r#"CREATE TABLE namespace (`id` BIGINT NOT NULL DEFAULT 0, `name` VARCHAR(1000) NOT NULL DEFAULT '', `is_active` BOOLEAN NOT NULL DEFAULT true, PRIMARY KEY (`id`)) ENGINE=InnoDB"#,
];

const EXTRA_SCHEMA: &[&str] = &[
    "CREATE TABLE users (id BIGINT PRIMARY KEY, user_name VARCHAR(255), password_hash VARCHAR(255) NOT NULL DEFAULT '', email VARCHAR(255), git_info JSON NOT NULL DEFAULT (JSON_OBJECT()), is_active BOOLEAN, role VARCHAR(32), auth_source VARCHAR(32) NOT NULL DEFAULT '', preferences TEXT NOT NULL DEFAULT ('{}'), created_at DATETIME NOT NULL DEFAULT '2026-01-01 00:00:00', updated_at DATETIME NOT NULL DEFAULT '2026-01-01 00:00:00')",
    "CREATE TABLE plugin_device_installations (id BIGINT PRIMARY KEY AUTO_INCREMENT, installed_kind_id BIGINT, user_id BIGINT, device_id VARCHAR(255), desired_release_id BIGINT NOT NULL, actual_release_id BIGINT NOT NULL, state VARCHAR(32), error_code VARCHAR(255) NOT NULL DEFAULT '', error_message VARCHAR(255) NOT NULL DEFAULT '', attempt_count BIGINT NOT NULL DEFAULT 0, last_sync_at DATETIME NOT NULL DEFAULT '1970-01-01 00:00:00', updated_at DATETIME NOT NULL DEFAULT '2026-01-01 00:00:00')",
];
pub(crate) async fn with_database<F, Fut>(run: F)
where
    F: FnOnce(MysqlService) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send,
{
    let address = std::env::var("WEGENT_TEST_MYSQL_ADDRESS")
        .expect("set WEGENT_TEST_MYSQL_ADDRESS to the disposable fixture");
    assert!(address.starts_with("127.0.0.1:"), "use a loopback fixture");
    let url = |name: &str| format!("mysql://root@{address}/{name}?ssl-mode=disabled");
    let admin = MysqlService::connect(&url("mysql")).await.unwrap();
    let name = unique_database_name("installed_list");
    admin
        .execute(format!("CREATE DATABASE {name}"), ())
        .await
        .unwrap();
    let mysql = MysqlService::connect(&url(&name)).await.unwrap();
    let test_mysql = mysql.clone();
    let result = tokio::spawn(async move {
        for sql in CATALOG_SCHEMA.iter().chain(EXTRA_SCHEMA) {
            test_mysql.execute(*sql, ()).await.unwrap();
        }
        test_mysql
            .execute(
                "INSERT INTO users (id,user_name,is_active,role) VALUES (7,'list-fixture',true,'user')",
                (),
            )
            .await
            .unwrap();
        run(test_mysql).await;
    })
    .await;
    mysql.close().await;
    admin
        .execute(format!("DROP DATABASE {name}"), ())
        .await
        .unwrap();
    admin.close().await;
    result.unwrap();
}

pub(crate) async fn seed(mysql: &MysqlService, count: i64) {
    for device in 1..=3 {
        let document =
            json!({"spec": {"deviceType": "app", "appDeviceId": format!("host-{device}")}});
        mysql.execute(
            "INSERT INTO kinds (id,user_id,kind,name,namespace,json,is_active) VALUES (?,7,'Device',?,'default',?,true)",
            (1000 + device, format!("device-{device}"), document.to_string()),
        ).await.unwrap();
    }
    for id in 1..=count {
        mysql.execute(
            "INSERT INTO kinds (id,user_id,kind,name,namespace,json,is_active,created_at) VALUES (?,7,'InstalledPlugin',?,'default',?,true,TIMESTAMPADD(SECOND,?, '2026-01-01 00:00:00'))",
            (id, format!("plugin-{id}"), installed_document(id).to_string(), id),
        ).await.unwrap();
        mysql
            .execute(
                "INSERT INTO plugins (id,latest_release_id) VALUES (?,10)",
                (id,),
            )
            .await
            .unwrap();
        for device in 1..=3 {
            mysql.execute(
                "INSERT INTO plugin_device_installations (installed_kind_id,user_id,device_id,desired_release_id,actual_release_id,state) VALUES (?,7,?,10,10,'installed')",
                (id, format!("host-{device}")),
            ).await.unwrap();
        }
    }
}
