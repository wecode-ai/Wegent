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
        let ssn = match purpose {
            ResolutionPurpose::SkillDownload => {
                self.0.resolve_employee_id(redis, user_id as i32).await?
            }
            _ => self.0.employee_id(user_id).await?,
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
