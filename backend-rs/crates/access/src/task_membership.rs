//! Approved, non-copied task membership queries.

/// `is_member`'s approved member-row check (only reached when the requesting
/// user is not the task owner).
///
/// Only row presence matters here, so the query selects a positional scalar
/// instead of coupling the probe to SQLAlchemy's labeled projection name.
pub async fn is_approved_member<M>(
    mysql: &M,
    task_id: i64,
    user_id: i64,
) -> brz_mysql::MysqlResult<bool>
where
    M: brz_mysql::Mysql,
{
    let row: Option<i64> = mysql
        .fetch_optional(
            "SELECT 1 \nFROM resource_members \n\
             WHERE resource_members.resource_type = 'Task' AND resource_members.resource_id = ? \
             AND resource_members.entity_type = 'user' AND resource_members.entity_id = ? \
             AND resource_members.status = 'approved' AND resource_members.copied_resource_id = 0 \n\
             LIMIT 1",
            (task_id, user_id.to_string()),
        )
        .await?;
    Ok(approved_member_row_exists(row))
}

fn approved_member_row_exists(row: Option<i64>) -> bool {
    row.is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn approved_member_probe_uses_a_positional_presence_scalar() {
        let mysql = wegent_backend_test_support::KindQueryCapture::default();

        let is_member = is_approved_member(&mysql, 42, 7).await.unwrap();

        assert!(!is_member);
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert_eq!(queries[0].args, 2);
        assert_eq!(queries[0].first_integer, Some(42));
        assert!(queries[0].sql.starts_with("SELECT 1 FROM resource_members"));
    }

    #[test]
    fn approved_member_probe_accepts_a_present_row() {
        assert!(approved_member_row_exists(Some(1)));
        assert!(!approved_member_row_exists(None));
    }
}
