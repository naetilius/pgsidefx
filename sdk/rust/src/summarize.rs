use std::collections::{HashMap, HashSet};

use tokio_postgres::{types::Type, Client, Row};

use crate::capture::{clear_sidefx_tables, collect_current_tx_sidefx};
use crate::error::PgSidefxError;
use crate::expect::{SideEffectAssertion, SidefxBoxFuture};
use crate::gucs::apply_pg_sidefx_gucs;
use crate::internal::{is_cascade_likely_query, is_internal_sidefx_query, query_touches_table};
use crate::types::{
    SidefxCapturedQuery, SidefxChangeSummary, SidefxQueryKind, SidefxRowEvent, SidefxSnapshotMap,
    SummarizeDbSideEffectsOptions,
};

fn cell_to_json(row: &Row, idx: usize, typ: &Type) -> serde_json::Value {
    let name = typ.name();
    let null = || serde_json::Value::Null;
    match name {
        "bool" => row
            .try_get::<_, Option<bool>>(idx)
            .ok()
            .flatten()
            .map(serde_json::Value::from)
            .unwrap_or_else(null),
        "int2" => row
            .try_get::<_, Option<i16>>(idx)
            .ok()
            .flatten()
            .map(|v| serde_json::Value::from(v as i64))
            .unwrap_or_else(null),
        "int4" => row
            .try_get::<_, Option<i32>>(idx)
            .ok()
            .flatten()
            .map(|v| serde_json::Value::from(v as i64))
            .unwrap_or_else(null),
        "int8" => row
            .try_get::<_, Option<i64>>(idx)
            .ok()
            .flatten()
            .map(serde_json::Value::from)
            .unwrap_or_else(null),
        "float4" | "float8" => row
            .try_get::<_, Option<f64>>(idx)
            .ok()
            .flatten()
            .map(serde_json::Value::from)
            .unwrap_or_else(null),
        "numeric" => row
            .try_get::<_, Option<String>>(idx)
            .ok()
            .flatten()
            .map(serde_json::Value::String)
            .unwrap_or_else(null),
        "text" | "varchar" | "bpchar" | "name" => row
            .try_get::<_, Option<String>>(idx)
            .ok()
            .flatten()
            .map(serde_json::Value::String)
            .unwrap_or_else(null),
        "json" | "jsonb" => row
            .try_get::<_, Option<serde_json::Value>>(idx)
            .ok()
            .flatten()
            .unwrap_or_else(null),
        "timestamp" | "timestamptz" => row
            .try_get::<_, Option<chrono::NaiveDateTime>>(idx)
            .ok()
            .flatten()
            .map(|t| serde_json::Value::String(t.to_string()))
            .unwrap_or_else(null),
        _ => row
            .try_get::<_, Option<String>>(idx)
            .ok()
            .flatten()
            .map(serde_json::Value::String)
            .unwrap_or_else(null),
    }
}

fn row_as_snapshot_row(row: &Row) -> HashMap<String, serde_json::Value> {
    let mut out = HashMap::new();
    for (i, col) in row.columns().iter().enumerate() {
        out.insert(col.name().to_string(), cell_to_json(row, i, col.type_()));
    }
    out
}

async fn run_snapshots(
    client: &Client,
    snapshots: Option<&HashMap<String, String>>,
) -> Result<SidefxSnapshotMap, PgSidefxError> {
    let Some(snaps) = snapshots else {
        return Ok(SidefxSnapshotMap::new());
    };
    let mut out = SidefxSnapshotMap::new();
    for (name, sql) in snaps {
        let rows = client.query(sql, &[]).await?;
        let row = rows.first().map(row_as_snapshot_row);
        out.insert(name.clone(), row);
    }
    Ok(out)
}

/// Structured report: snapshots, row events, filtered queries, and raw rows (mirrors TS `summarizeDbSideEffects`).
pub async fn summarize_db_side_effects<'a, T: Send>(
    client: &'a Client,
    action: impl FnOnce(&'a Client) -> SidefxBoxFuture<'a, T>,
    options: Option<SummarizeDbSideEffectsOptions>,
) -> Result<SidefxChangeSummary<T>, PgSidefxError> {
    client.execute("BEGIN", &[]).await?;

    let run = async {
        if let Some(ref o) = options {
            if let Some(ref g) = o.gucs {
                apply_pg_sidefx_gucs(client, g).await?;
            }
        }

        clear_sidefx_tables(client).await?;

        let before = run_snapshots(client, options.as_ref().and_then(|o| o.snapshots.as_ref()))
            .await?;
        let result = action(client).await?;
        let after = run_snapshots(client, options.as_ref().and_then(|o| o.snapshots.as_ref()))
            .await?;

        let (summary, plan_rows, utility_rows, utility_summary) =
            collect_current_tx_sidefx(client).await?;

        let assertion = SideEffectAssertion {
            summary,
            plan_rows,
            utility_rows,
            utility_summary,
        };

        let raw_row_events = client
            .query(
                "SELECT table_schema, table_name, operation, is_cascade, depth, created_at
                 FROM sidefx_log
                 WHERE txid = txid_current()::bigint
                 ORDER BY id",
                &[],
            )
            .await?;

        let row_events: Vec<SidefxRowEvent> = raw_row_events
            .iter()
            .map(|r| SidefxRowEvent {
                table: format!("{}.{}", r.get::<_, String>(0), r.get::<_, String>(1)),
                operation: r.get(2),
                is_cascade: r.try_get::<_, bool>(3).unwrap_or(false),
                depth: r.get::<_, i32>(4),
                created_at: r.get(5),
            })
            .collect();

        let cascade_tables: HashSet<String> = row_events
            .iter()
            .filter(|e| e.is_cascade)
            .map(|e| e.table.clone())
            .collect();

        let plan_rows: Vec<_> = assertion
            .plan_rows
            .iter()
            .filter(|row| !is_internal_sidefx_query(row.query.as_deref().unwrap_or("")))
            .cloned()
            .collect();

        let utility_rows: Vec<_> = assertion
            .utility_rows
            .iter()
            .filter(|row| !is_internal_sidefx_query(row.query_text.as_deref().unwrap_or("")))
            .cloned()
            .collect();

        let mut tables_changed: Vec<String> = assertion.summary.keys().cloned().collect();
        tables_changed.sort();

        let mut queries: Vec<SidefxCapturedQuery> = Vec::new();

        for row in &plan_rows {
            let text = row.query.clone().unwrap_or_default();
            if text.trim().is_empty() {
                continue;
            }
            let is_cascade_related = is_cascade_likely_query(&text)
                || cascade_tables
                    .iter()
                    .any(|t| query_touches_table(&text, t));
            queries.push(SidefxCapturedQuery {
                kind: SidefxQueryKind::Plan,
                text,
                stmt_tag: None,
                indexes_used: row.indexes_used.clone(),
                is_cascade_related: Some(is_cascade_related),
            });
        }

        for row in &utility_rows {
            let text = row.query_text.clone().unwrap_or_default();
            if text.trim().is_empty() {
                continue;
            }
            let is_cascade_related = cascade_tables
                .iter()
                .any(|t| query_touches_table(&text, t));
            queries.push(SidefxCapturedQuery {
                kind: SidefxQueryKind::Utility,
                text,
                stmt_tag: Some(row.stmt_tag.clone()),
                indexes_used: None,
                is_cascade_related: Some(is_cascade_related),
            });
        }

        client.execute("ROLLBACK", &[]).await?;

        Ok(SidefxChangeSummary {
            result,
            before,
            after,
            side_effects: assertion.summary,
            utility: assertion.utility_summary,
            tables_changed,
            queries,
            row_events,
            plan_rows,
            utility_rows,
        })
    };

    match run.await {
        Ok(v) => Ok(v),
        Err(e) => {
            let _ = client.execute("ROLLBACK", &[]).await;
            Err(e)
        }
    }
}
