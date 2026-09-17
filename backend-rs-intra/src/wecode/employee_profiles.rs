//! Private employee-profile persistence and source-compatible projections.
use brz_mysql::{FromMysqlRow, Mysql, MysqlResult};
const ERP_COLUMNS: &str = "wecode_erp_user.id AS wecode_erp_user_id, \
     wecode_erp_user.user_id AS wecode_erp_user_user_id, \
     wecode_erp_user.employee_id AS wecode_erp_user_employee_id, \
     wecode_erp_user.department_name AS wecode_erp_user_department_name, \
     wecode_erp_user.erp_name AS wecode_erp_user_erp_name, \
     wecode_erp_user.email AS wecode_erp_user_email, \
     wecode_erp_user.last_synced_at AS wecode_erp_user_last_synced_at, \
     wecode_erp_user.created_at AS wecode_erp_user_created_at, \
     wecode_erp_user.updated_at AS wecode_erp_user_updated_at";
#[derive(FromMysqlRow)]
struct ProfileRow {
    wecode_erp_user_employee_id: String,
}

pub async fn employee_id<M: Mysql>(mysql: &M, user_id: i64) -> MysqlResult<Option<String>> {
    let sql = format!(
        "SELECT {ERP_COLUMNS} FROM wecode_erp_user WHERE wecode_erp_user.user_id = ? LIMIT 1"
    );
    let row: Option<ProfileRow> = mysql.fetch_optional(sql, (user_id,)).await?;
    Ok(row.and_then(|row| {
        let id = row.wecode_erp_user_employee_id.trim().to_string();
        (!id.is_empty()).then_some(id)
    }))
}
