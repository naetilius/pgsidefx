use postgres_types::Json;
use tokio_postgres::Client;

use crate::error::PgSidefxError;
use crate::types::{
    ExpectDbSideEffectsOptions, QueryPlanRow, SideEffectSummary, UtilityLogRow, UtilitySummary,
};

pub(crate) async fn clear_sidefx_tables(client: &Client) -> Result<(), PgSidefxError> {
    client.execute("DELETE FROM sidefx_log", &[]).await?;
    client
        .execute("DELETE FROM sidefx_query_plan", &[])
        .await?;
    client
        .execute("DELETE FROM sidefx_utility_log", &[])
        .await?;
    Ok(())
}

fn json_summary(row: &tokio_postgres::Row, idx: usize) -> SideEffectSummary {
    let v: Option<Json<serde_json::Value>> = row.get(idx);
    v.and_then(|Json(val)| serde_json::from_value(val).ok())
        .unwrap_or_default()
}

fn json_utility_summary(row: &tokio_postgres::Row, idx: usize) -> UtilitySummary {
    let v: Option<Json<serde_json::Value>> = row.get(idx);
    let Some(Json(serde_json::Value::Object(map))) = v else {
        return UtilitySummary::new();
    };
    let mut out = UtilitySummary::new();
    for (k, val) in map {
        let n = val
            .as_i64()
            .or_else(|| val.as_f64().map(|f| f as i64))
            .unwrap_or(0);
        out.insert(k, n);
    }
    out
}

pub(crate) async fn collect_current_tx_sidefx(
    client: &Client,
) -> Result<
    (
        SideEffectSummary,
        Vec<QueryPlanRow>,
        Vec<UtilityLogRow>,
        UtilitySummary,
    ),
    PgSidefxError,
> {
    let summary_row = client
        .query_one(
            "SELECT sidefx_summary(txid_current()::bigint) AS sidefx_summary",
            &[],
        )
        .await?;
    let summary = json_summary(&summary_row, 0);

    let plan_rows = client
        .query(
            "SELECT id, txid, query, plan, has_index_scan, indexes_used, created_at
             FROM sidefx_query_plan WHERE txid = txid_current()::bigint",
            &[],
        )
        .await?;

    let mut plans = Vec::with_capacity(plan_rows.len());
    for r in plan_rows {
        let plan: Option<Json<serde_json::Value>> = r.get(3);
        let plan = plan.map(|j| j.0).unwrap_or(serde_json::Value::Null);
        plans.push(QueryPlanRow {
            id: r.get(0),
            txid: r.get(1),
            query: r.get(2),
            plan,
            has_index_scan: r.get(4),
            indexes_used: r.get(5),
            created_at: r.get(6),
        });
    }

    let util_rows = client
        .query(
            "SELECT id, txid, stmt_tag, query_text, object_schema, object_type, object_name, correlation_label, created_at
             FROM sidefx_utility_log WHERE txid = txid_current()::bigint ORDER BY id",
            &[],
        )
        .await?;

    let mut utilities = Vec::with_capacity(util_rows.len());
    for r in util_rows {
        utilities.push(UtilityLogRow {
            id: r.get(0),
            txid: r.get(1),
            stmt_tag: r.get(2),
            query_text: r.get(3),
            object_schema: r.get(4),
            object_type: r.get(5),
            object_name: r.get(6),
            correlation_label: r.get(7),
            created_at: r.get(8),
        });
    }

    let util_summary_row = client
        .query_one(
            "SELECT sidefx_utility_summary(txid_current()::bigint) AS sidefx_utility_summary",
            &[],
        )
        .await?;
    let utility_summary = json_utility_summary(&util_summary_row, 0);

    Ok((summary, plans, utilities, utility_summary))
}

pub(crate) fn merged_expect_options(
    base: Option<&ExpectDbSideEffectsOptions>,
    call: Option<&ExpectDbSideEffectsOptions>,
) -> Option<ExpectDbSideEffectsOptions> {
    if base.is_none() && call.is_none() {
        return None;
    }
    let mut gucs = crate::types::PgSidefxGucs::default();
    if let Some(b) = base {
        if let Some(ref bg) = b.gucs {
            gucs = bg.clone();
        }
    }
    if let Some(c) = call {
        if let Some(ref cg) = c.gucs {
            if cg.enabled.is_some() {
                gucs.enabled = cg.enabled;
            }
            if cg.allowed_databases.is_some() {
                gucs.allowed_databases = cg.allowed_databases.clone();
            }
            if cg.row_include_schemas.is_some() {
                gucs.row_include_schemas = cg.row_include_schemas.clone();
            }
            if cg.row_exclude_schemas.is_some() {
                gucs.row_exclude_schemas = cg.row_exclude_schemas.clone();
            }
            if cg.log_utility.is_some() {
                gucs.log_utility = cg.log_utility;
            }
        }
    }
    Some(ExpectDbSideEffectsOptions {
        gucs: Some(gucs),
    })
}
