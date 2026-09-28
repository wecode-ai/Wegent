// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Public namespace entity resolver backed by the shared resource-members table.
use super::*;
use brz_mysql::{FromMysqlRow, Mysql};
pub(super) struct NamespaceResolver(pub brz_mysql::MysqlService);
#[derive(FromMysqlRow)]
struct IdRow {
    resource_members_resource_id: i64,
}
#[derive(FromMysqlRow)]
struct BindingRow {
    resource_members_resource_id: i64,
    resource_members_entity_type: String,
    resource_members_entity_id: String,
}
#[async_trait]
impl<R: Redis> EntityResolver<R> for NamespaceResolver {
    async fn match_bindings(
        &self,
        registry: &EntityResolvers<R>,
        redis: Option<&R>,
        user_id: i64,
        entity_ids: &[String],
        purpose: ResolutionPurpose,
    ) -> MysqlResult<Vec<String>> {
        let ids: Vec<i64> = entity_ids.iter().filter_map(|id| id.parse().ok()).collect();
        let hits =
            namespace_entity_matches(&self.0, redis, registry, user_id, &ids, purpose).await?;
        Ok(entity_ids
            .iter()
            .filter(|id| id.parse::<i64>().is_ok_and(|id| hits.contains(&id)))
            .cloned()
            .collect())
    }
}
/// `NamespaceEntityResolver.match_entity_bindings` for `namespace` ids:
/// direct user memberships plus entity-derived matches through the other
/// resolvers; returns the matched namespace id strings.
async fn namespace_entity_matches<M, R>(
    mysql: &M,
    redis: Option<&R>,
    resolvers: &crate::permissions::EntityResolvers<R>,
    user_id: i64,
    namespace_ids: &[i64],
    purpose: ResolutionPurpose,
) -> MysqlResult<Vec<i64>>
where
    M: Mysql,
    R: brz_redis::Redis,
{
    if namespace_ids.is_empty() {
        return Ok(Vec::new());
    }
    let ids = namespace_ids
        .iter()
        .map(|id| id.to_string())
        .collect::<Vec<_>>()
        .join(", ");
    let mut matched: Vec<i64> = Vec::new();

    // 1) Direct user memberships of those namespaces.
    let direct: Vec<IdRow> = mysql
        .fetch_all(
            &format!(
                "SELECT resource_members.resource_id AS resource_members_resource_id \n\
                 FROM resource_members \n\
                 WHERE resource_members.resource_type = 'Namespace' \
                 AND resource_members.resource_id IN ({ids}) \
                 AND resource_members.entity_type = 'user' \
                 AND resource_members.entity_id = '{}' \
                 AND resource_members.status = 'approved'",
                user_id
            ),
            (),
        )
        .await?;
    matched.extend(
        direct
            .into_iter()
            .map(|row| row.resource_members_resource_id),
    );

    // 2) Non-user entity members of those namespaces, delegated per type.
    let entity_members: Vec<BindingRow> = mysql
        .fetch_all(
            &format!(
                "SELECT resource_members.resource_id AS resource_members_resource_id, \
                 resource_members.entity_id AS resource_members_entity_id, \
                 resource_members.entity_type AS resource_members_entity_type \n\
                 FROM resource_members \n\
                 WHERE resource_members.resource_type = 'Namespace' \
                 AND resource_members.resource_id IN ({ids}) \
                 AND resource_members.entity_type != 'user' \
                 AND resource_members.status = 'approved'"
            ),
            (),
        )
        .await?;
    resolve_memberships(resolvers, redis, user_id, purpose, matched, entity_members).await
}

async fn resolve_memberships<R: Redis>(
    resolvers: &EntityResolvers<R>,
    redis: Option<&R>,
    user_id: i64,
    purpose: ResolutionPurpose,
    mut matched: Vec<i64>,
    entity_members: Vec<BindingRow>,
) -> MysqlResult<Vec<i64>> {
    let mut groups = std::collections::BTreeMap::<&str, Vec<&BindingRow>>::new();
    for row in &entity_members {
        groups
            .entry(&row.resource_members_entity_type)
            .or_default()
            .push(row);
    }
    for (entity_type, rows) in groups {
        let ids = rows
            .iter()
            .map(|row| row.resource_members_entity_id.clone())
            .collect::<Vec<_>>();
        let hits = resolvers
            .match_bindings(redis, user_id, entity_type, &ids, purpose)
            .await?;
        matched.extend(
            rows.iter()
                .filter(|row| hits.contains(&row.resource_members_entity_id))
                .map(|row| row.resource_members_resource_id),
        );
    }
    Ok(matched)
}

#[cfg(test)]
mod tests {
    use super::*;
    use brz_redis::RedisService;

    fn registry() -> EntityResolvers {
        EntityResolvers::public(
            brz_mysql::MysqlService::connect_lazy("mysql://test:test@127.0.0.1:1/test").unwrap(),
        )
    }
    struct MatchesOne;
    #[async_trait]
    impl EntityResolver<RedisService> for MatchesOne {
        async fn match_bindings(
            &self,
            _: &EntityResolvers,
            _: Option<&RedisService>,
            _: i64,
            ids: &[String],
            _: ResolutionPurpose,
        ) -> MysqlResult<Vec<String>> {
            Ok(ids
                .iter()
                .filter(|id| id.as_str() == "allowed")
                .cloned()
                .collect())
        }
    }
    fn binding(namespace: i64, id: &str) -> BindingRow {
        BindingRow {
            resource_members_resource_id: namespace,
            resource_members_entity_type: "external_team".into(),
            resource_members_entity_id: id.into(),
        }
    }
    #[tokio::test]
    async fn public_defaults_preserve_direct_membership_and_skip_unregistered_entities() {
        let registry = registry();
        assert!(registry.contains("namespace"));
        assert_eq!(registry.external_types().count(), 0);
        let matched = resolve_memberships(
            &registry,
            None,
            7,
            ResolutionPurpose::ResourceAccess,
            vec![1],
            vec![binding(2, "allowed")],
        )
        .await
        .unwrap();
        assert_eq!(matched, [1]);
        assert!(
            registry
                .match_bindings(
                    None,
                    7,
                    "namespace",
                    &["invalid".into()],
                    ResolutionPurpose::ResourceAccess
                )
                .await
                .unwrap()
                .is_empty()
        );
    }
    #[tokio::test]
    async fn registered_entities_add_only_matching_namespace_memberships() {
        let mut registry = registry();
        registry.register("external_team", MatchesOne);
        let matched = resolve_memberships(
            &registry,
            None,
            7,
            ResolutionPurpose::ResourceAccess,
            vec![1],
            vec![binding(2, "allowed"), binding(3, "denied")],
        )
        .await
        .unwrap();
        assert_eq!(matched, [1, 2]);
    }
    struct CyclicResolver;
    #[async_trait]
    impl EntityResolver<RedisService> for CyclicResolver {
        async fn match_bindings(
            &self,
            registry: &EntityResolvers,
            redis: Option<&RedisService>,
            user_id: i64,
            ids: &[String],
            purpose: ResolutionPurpose,
        ) -> MysqlResult<Vec<String>> {
            registry
                .match_bindings(redis, user_id, "cycle", ids, purpose)
                .await
        }
    }
    #[tokio::test]
    async fn cyclic_entities_do_not_grant_access_or_affect_later_resolutions() {
        let mut registry = registry();
        registry.register("cycle", CyclicResolver);
        assert!(
            registry
                .match_bindings(
                    None,
                    7,
                    "cycle",
                    &["1".into()],
                    ResolutionPurpose::ResourceAccess
                )
                .await
                .unwrap()
                .is_empty()
        );
        registry.register("external_team", MatchesOne);
        assert_eq!(
            registry
                .match_bindings(
                    None,
                    7,
                    "external_team",
                    &["allowed".into()],
                    ResolutionPurpose::ResourceAccess
                )
                .await
                .unwrap(),
            ["allowed"]
        );
    }
}
