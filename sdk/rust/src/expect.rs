use std::future::Future;
use std::pin::Pin;

use tokio_postgres::Client;

use crate::capture::{clear_sidefx_tables, collect_current_tx_sidefx};
use crate::error::PgSidefxError;
use crate::gucs::apply_pg_sidefx_gucs;
use crate::types::{
    ExpectDbSideEffectsOptions, QueryPlanRow, SideEffectSummary, UtilityLogRow, UtilitySummary,
};

/// Boxed async work tied to a borrowed [`Client`](tokio_postgres::Client) lifetime (for use with pools).
pub type SidefxBoxFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, PgSidefxError>> + Send + 'a>>;

/// Captured side effects for the current transaction (after [`expect_db_side_effects`] runs its closure).
#[derive(Debug, Clone)]
pub struct SideEffectAssertion {
    pub summary: SideEffectSummary,
    pub plan_rows: Vec<QueryPlanRow>,
    pub utility_rows: Vec<UtilityLogRow>,
    pub utility_summary: UtilitySummary,
}

impl SideEffectAssertion {
    /// Subset match on [`SideEffectSummary`] (same spirit as Vitest `toMatchObject`).
    pub fn to_match(&self, expected: &SideEffectSummary) {
        for (table, exp) in expected {
            let Some(act) = self.summary.get(table) else {
                panic!("side effect summary: missing table {table:?}; got {:?}", self.summary);
            };
            if let Some(v) = exp.inserted {
                assert_eq!(
                    act.inserted,
                    Some(v),
                    "table {table}: inserted expected {v}, got {:?}",
                    act.inserted
                );
            }
            if let Some(v) = exp.updated {
                assert_eq!(
                    act.updated,
                    Some(v),
                    "table {table}: updated expected {v}, got {:?}",
                    act.updated
                );
            }
            if let Some(v) = exp.deleted {
                assert_eq!(
                    act.deleted,
                    Some(v),
                    "table {table}: deleted expected {v}, got {:?}",
                    act.deleted
                );
            }
        }
    }

    pub fn utilities_to_match(&self, expected: &UtilitySummary) {
        for (k, v) in expected {
            let Some(act) = self.utility_summary.get(k) else {
                panic!(
                    "utility summary: missing key {k:?}; got {:?}",
                    self.utility_summary
                );
            };
            assert_eq!(act, v, "utility key {k}");
        }
    }

    pub fn used_index(&self, index_name: &str) {
        let found = self.plan_rows.iter().any(|p| {
            p.indexes_used
                .as_ref()
                .is_some_and(|ix| ix.iter().any(|n| n == index_name))
        });
        assert!(
            found,
            "expected index {index_name:?} in indexes_used; plans: {:?}",
            self.plan_rows
                .iter()
                .map(|p| &p.indexes_used)
                .collect::<Vec<_>>()
        );
    }

    pub fn only_affected_tables(&self, expected_tables: &[&str]) {
        let mut actual: Vec<&str> = self.summary.keys().map(String::as_str).collect();
        actual.sort_unstable();
        let mut expected: Vec<&str> = expected_tables.to_vec();
        expected.sort_unstable();
        assert_eq!(actual, expected, "only_affected_tables mismatch");
    }

    pub fn not_affected_tables(&self, tables: &[&str]) {
        for t in tables {
            assert!(
                !self.summary.contains_key(*t),
                "table {t:?} should not be affected"
            );
        }
    }

    /// Same rules as TypeScript: only `SELECT` plans; ignore `count(` and `coalesce` wrapper queries.
    pub fn no_seq_scan(&self, table: &str) {
        let select_plans: Vec<&QueryPlanRow> = self
            .plan_rows
            .iter()
            .filter(|p| {
                let q = p.query.as_deref().unwrap_or("").trim();
                let ql = q.to_lowercase();
                ql.starts_with("select")
                    && !ql.starts_with("select count(")
                    && !ql.starts_with("select coalesce")
            })
            .collect();
        let haystack = select_plans
            .iter()
            .map(|p| match &p.plan {
                serde_json::Value::String(s) => s.clone(),
                other => other.to_string(),
            })
            .collect::<Vec<_>>()
            .join("\n");
        let rel = format!("\"relation\":\"{table}\"");
        let has_seq = haystack.contains("SeqScan") && haystack.contains(&rel);
        assert!(
            !has_seq,
            "expected no SeqScan on {table:?} in SELECT plans; haystack snippet: {}",
            haystack.chars().take(500).collect::<String>()
        );
    }
}

/// Wrap `action` in `BEGIN` … `ROLLBACK`, clear sidefx tables, optionally apply GUCs, then capture.
pub async fn expect_db_side_effects<'a>(
    client: &'a Client,
    action: impl FnOnce(&'a Client) -> SidefxBoxFuture<'a, ()>,
    options: Option<ExpectDbSideEffectsOptions>,
) -> Result<SideEffectAssertion, PgSidefxError> {
    client.execute("BEGIN", &[]).await?;

    if let Some(ref o) = options {
        if let Some(ref g) = o.gucs {
            apply_pg_sidefx_gucs(client, g).await?;
        }
    }

    clear_sidefx_tables(client).await?;
    action(client).await?;

    let (summary, plan_rows, utility_rows, utility_summary) =
        collect_current_tx_sidefx(client).await?;

    client.execute("ROLLBACK", &[]).await?;

    Ok(SideEffectAssertion {
        summary,
        plan_rows,
        utility_rows,
        utility_summary,
    })
}
