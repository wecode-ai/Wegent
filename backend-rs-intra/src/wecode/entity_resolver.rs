//! Department bindings backed by private employee profiles and ERP membership.
use async_trait::async_trait;
use brz_mysql::MysqlResult;
use brz_redis::Redis;
use std::sync::Arc;
use wegent_backend_rs::{
    erp_provider::ErpProvider,
    permissions::{EntityResolver, EntityResolvers, ResolutionPurpose},
};

pub struct DepartmentResolver<R: Redis>(pub Arc<dyn ErpProvider<R>>);
#[async_trait]
impl<R: Redis> EntityResolver<R> for DepartmentResolver<R> {
    async fn match_bindings(
        &self,
        _: &EntityResolvers<R>,
        redis: Option<&R>,
        user_id: i64,
        entity_ids: &[String],
        purpose: ResolutionPurpose,
    ) -> MysqlResult<Vec<String>> {
        // `ErpEntityResolver._resolve_matched_departments` resolves the
        // employee id through `_get_user_ssn`, whose fallback lazily syncs the
        // ERP profile (`wecode_erp_user` read, `users` email, the
        // `wegent:lock:erp_profile_sync:{user_id}` lock, `/api/open/search`)
        // whenever the stored profile has no employee id. That resolution is
        // not download-specific: the group-membership resolvers of
        // `iter_user_groups_with_roles` and `get_resource_ids_by_entity` run
        // the same sync for the ordinary resource-access purpose. Only the
        // cache-only document-read path skips it.
        let ssn = match purpose {
            ResolutionPurpose::CachedResourceAccess => self.0.employee_id(user_id).await?,
            _ => self.0.resolve_employee_id(redis, user_id as i32).await?,
        };
        let Some(ssn) = ssn else {
            return Ok(Vec::new());
        };
        Ok(match purpose {
            ResolutionPurpose::CachedResourceAccess => {
                self.0
                    .cached_membership(redis, user_id, &ssn, entity_ids)
                    .await
            }
            _ => {
                self.0
                    .membership_with_cache(redis, user_id as i32, &ssn, entity_ids)
                    .await
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use wegent_backend_rs::erp_types::EmployeeInfo;

    /// Records the provider calls so the purpose-to-path mapping is observable
    /// without a database or an ERP endpoint.
    #[derive(Default)]
    struct RecordingProvider {
        calls: Mutex<Vec<&'static str>>,
    }

    impl RecordingProvider {
        fn record(&self, call: &'static str) {
            self.calls.lock().unwrap().push(call);
        }
    }

    #[async_trait]
    impl<R: Redis> ErpProvider<R> for RecordingProvider {
        async fn employee_id(&self, _user_id: i64) -> MysqlResult<Option<String>> {
            self.record("employee_id");
            Ok(Some("100178".to_string()))
        }
        async fn resolve_employee_id(
            &self,
            _redis: Option<&R>,
            _user_id: i32,
        ) -> MysqlResult<Option<String>> {
            self.record("resolve_employee_id");
            Ok(Some("100178".to_string()))
        }
        async fn cached_membership(
            &self,
            _redis: Option<&R>,
            _user_id: i64,
            _ssn: &str,
            dept_ids: &[String],
        ) -> Vec<String> {
            self.record("cached_membership");
            dept_ids.to_vec()
        }
        async fn membership_with_cache(
            &self,
            _redis: Option<&R>,
            _user_id: i32,
            _ssn: &str,
            dept_ids: &[String],
        ) -> Vec<String> {
            self.record("membership_with_cache");
            dept_ids.to_vec()
        }
        async fn search_employee(&self, _keyword: &str) -> Option<EmployeeInfo> {
            None
        }
        fn entity_type(&self) -> Option<&'static str> {
            Some("org_department")
        }
    }

    /// The recorded `f0beba21` case: the same user is resolved through the
    /// lazily-synced profile for the group-membership and KB-entity sites of
    /// the all-grouped request, so `ResourceAccess` must not take the
    /// profile-only shortcut. The cache-only document-read path keeps it.
    #[tokio::test]
    async fn resource_access_resolves_the_profile_with_the_sync_fallback() {
        let provider = Arc::new(RecordingProvider::default());
        let registry: EntityResolvers = EntityResolvers::public(
            brz_mysql::MysqlService::connect_lazy("mysql://test:test@127.0.0.1:1/test").unwrap(),
        );
        let resolver = DepartmentResolver(provider.clone());
        let entity_ids = vec!["100178".to_string()];

        for (label, purpose, expected) in [
            (
                "resource_access",
                ResolutionPurpose::ResourceAccess,
                ["resolve_employee_id", "membership_with_cache"],
            ),
            (
                "skill_download",
                ResolutionPurpose::SkillDownload,
                ["resolve_employee_id", "membership_with_cache"],
            ),
            (
                "cached_resource_access",
                ResolutionPurpose::CachedResourceAccess,
                ["employee_id", "cached_membership"],
            ),
        ] {
            provider.calls.lock().unwrap().clear();
            let matched = resolver
                .match_bindings(&registry, None, 6611, &entity_ids, purpose)
                .await
                .expect("the recording provider never fails");
            assert_eq!(matched, entity_ids);
            assert_eq!(
                provider.calls.lock().unwrap().as_slice(),
                expected.as_slice(),
                "unexpected provider path for {label}"
            );
        }
    }
}
