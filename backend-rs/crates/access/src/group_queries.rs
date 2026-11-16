//! Group membership projections and namespace lookups.

use brz_mysql::{FromMysqlRow, Mysql, MysqlResult};
use wegent_backend_persistence::sql_support::placeholders;

/// `resource_members` column list rendered by `db.query(ResourceMember)`.
pub const MEMBER_COLUMNS: &str = "resource_members.id AS resource_members_id, \
     resource_members.resource_type AS resource_members_resource_type, \
     resource_members.resource_id AS resource_members_resource_id, \
     resource_members.entity_type AS resource_members_entity_type, \
     resource_members.entity_id AS resource_members_entity_id, \
     resource_members.entity_display_name AS resource_members_entity_display_name, \
     resource_members.user_id AS resource_members_user_id, \
     resource_members.`role` AS resource_members_role, \
     resource_members.status AS resource_members_status, \
     resource_members.invited_by_user_id AS resource_members_invited_by_user_id, \
     resource_members.share_link_id AS resource_members_share_link_id, \
     resource_members.reviewed_by_user_id AS resource_members_reviewed_by_user_id, \
     resource_members.reviewed_at AS resource_members_reviewed_at, \
     resource_members.copied_resource_id AS resource_members_copied_resource_id, \
     resource_members.requested_at AS resource_members_requested_at, \
     resource_members.created_at AS resource_members_created_at, \
     resource_members.updated_at AS resource_members_updated_at";
/// One bound SQL argument that preserves the recorded literal's token kind.
///
/// The replay matcher compares bound values by type as well as by value, so an
/// integer column (`kinds.user_id`, `resource_members.resource_id`) must bind as
/// `Int` and everything the source renders as a quoted string (entity ids,
/// namespaces, database names) as `Str`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BindingArg {
    Int(i64),
    Str(String),
}

impl brz_mysql::MysqlValue for BindingArg {
    fn write(self, writer: &mut brz_mysql::MysqlValueWriter) -> MysqlResult<()> {
        match self {
            Self::Int(value) => value.write(writer),
            Self::Str(value) => value.write(writer),
        }
    }
    fn encoded_size_hint(&self) -> usize {
        match self {
            Self::Int(value) => value.encoded_size_hint(),
            Self::Str(value) => value.encoded_size_hint(),
        }
    }
}

/// All active namespace names
/// (`get_user_group_roles`: `db.query(Namespace.name).filter(is_active)`).
pub async fn active_namespace_names<M>(mysql: &M) -> MysqlResult<Vec<String>>
where
    M: Mysql,
{
    #[derive(Debug, FromMysqlRow)]
    struct Row {
        namespace_name: String,
    }
    let rows: Vec<Row> = mysql
        .fetch_all(
            "SELECT namespace.name AS namespace_name \
             FROM namespace \
             WHERE namespace.is_active IS true",
            (),
        )
        .await?;
    Ok(rows.into_iter().map(|row| row.namespace_name).collect())
}

/// Namespace rows by id (`iter_user_groups_with_roles` step 1 tail). `ids`
/// keeps the caller's order (the source passes the raw membership row ids,
/// duplicates included).
/// Resource ids for direct user memberships
/// (`NamespaceEntityResolver.get_resource_ids_by_entity` step 1).
/// Namespace ids bound to an external entity type
/// (`NamespaceEntityResolver.get_resource_ids_by_entity` step 2).
/// Distinct namespace ids bound to the matched external entities
/// (`list_resources_by_entity_match`).
/// External entity members of the given namespaces
/// (`iter_user_groups_with_roles` step 2).
///
/// `resource_members.resource_id` is an integer column: the source builds the
/// IN list from the resolver's integer resource ids, so the target binds them
/// as integers and only `entity_type` as a string.
/// The external-members query's bound values: the integer namespace ids in the
/// caller's order, then the string entity type.
/// Namespace ids by names, active only
/// (`_get_accessible_authorization_namespace_ids` tail). `names` is sorted by
/// the caller exactly like the source's `sorted(effective_roles)`.
pub async fn namespace_ids_by_names<M>(mysql: &M, names: &[String]) -> MysqlResult<Vec<i64>>
where
    M: Mysql,
{
    if names.is_empty() {
        return Ok(Vec::new());
    }
    #[derive(Debug, FromMysqlRow)]
    struct Row {
        namespace_id: i64,
    }
    let sql = format!(
        "SELECT namespace.id AS namespace_id \
         FROM namespace \
         WHERE namespace.name IN ({}) AND namespace.is_active IS true",
        placeholders(names.len()),
    );
    let rows: Vec<Row> = mysql.fetch_all(sql.as_str(), names.to_vec()).await?;
    Ok(rows.into_iter().map(|row| row.namespace_id).collect())
}
