use tokio_postgres::Client;

use crate::error::PgSidefxError;
use crate::types::PgSidefxGucs;

fn esc_sql_string(s: &str) -> String {
    s.replace('\'', "''")
}

/// Apply `pg_sidefx.*` session settings using `SET LOCAL` (transaction-scoped).
pub async fn apply_pg_sidefx_gucs(
    client: &Client,
    gucs: &PgSidefxGucs,
) -> Result<(), PgSidefxError> {
    if let Some(enabled) = gucs.enabled {
        let v = if enabled { "on" } else { "off" };
        client
            .execute(
                &format!("SET LOCAL pg_sidefx.enabled = {v}"),
                &[],
            )
            .await?;
    }
    if let Some(ref allowed) = gucs.allowed_databases {
        client
            .execute(
                &format!(
                    "SET LOCAL pg_sidefx.allowed_databases = '{}'",
                    esc_sql_string(allowed)
                ),
                &[],
            )
            .await?;
    }
    if let Some(ref inc) = gucs.row_include_schemas {
        client
            .execute(
                &format!(
                    "SET LOCAL pg_sidefx.row_include_schemas = '{}'",
                    esc_sql_string(inc)
                ),
                &[],
            )
            .await?;
    }
    if let Some(ref exc) = gucs.row_exclude_schemas {
        client
            .execute(
                &format!(
                    "SET LOCAL pg_sidefx.row_exclude_schemas = '{}'",
                    esc_sql_string(exc)
                ),
                &[],
            )
            .await?;
    }
    if let Some(log_utility) = gucs.log_utility {
        let v = if log_utility { "on" } else { "off" };
        client
            .execute(
                &format!("SET LOCAL pg_sidefx.log_utility = {v}"),
                &[],
            )
            .await?;
    }
    Ok(())
}
