//! Rust SDK for the `pg_sidefx` PostgreSQL extension: transaction-scoped
//! capture helpers for integration tests (parity with the TypeScript layer in `src/`).

pub use deadpool_postgres;

mod assertions;
mod capture;
mod client;
mod error;
mod expect;
pub mod gucs;
mod internal;
mod summarize;
mod types;

pub use assertions::{
    assert_numeric_eq, assert_row_count, assert_sum_eq, assert_text_eq, explain_index_names,
    explain_node_types, explain_plan_json, explain_root_plan, explain_total_cost,
    expect_explain_node_types_absent, expect_explain_uses_index, expect_index_used_from_set,
    expect_no_seq_scan_on, expect_plan_cost_at_most, sidefx_count, sidefx_sum, walk_explain_plans,
};
pub use client::PgSideFx;
pub use error::PgSidefxError;
pub use expect::{expect_db_side_effects, SideEffectAssertion, SidefxBoxFuture};
pub use gucs::apply_pg_sidefx_gucs;
pub use summarize::summarize_db_side_effects;
pub use types::{
    ExpectDbSideEffectsOptions, PgSidefxGucs, QueryPlanRow, SideEffectSummary, SideEffectTableStats,
    SidefxCapturedQuery, SidefxChangeSummary, SidefxQueryKind, SidefxRowEvent, SidefxSnapshotMap,
    SidefxSnapshotRow, SummarizeDbSideEffectsOptions, UtilityLogRow, UtilitySummary,
};
