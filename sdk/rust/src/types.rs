use std::collections::HashMap;

use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct SideEffectTableStats {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inserted: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted: Option<i64>,
}

pub type SideEffectSummary = HashMap<String, SideEffectTableStats>;

pub type UtilitySummary = HashMap<String, i64>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UtilityLogRow {
    pub id: i64,
    pub txid: i64,
    pub stmt_tag: String,
    pub query_text: Option<String>,
    pub object_schema: Option<String>,
    pub object_type: Option<String>,
    pub object_name: Option<String>,
    pub correlation_label: Option<String>,
    pub created_at: NaiveDateTime,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct QueryPlanRow {
    pub id: i64,
    pub txid: i64,
    pub query: Option<String>,
    pub plan: Value,
    pub has_index_scan: bool,
    pub indexes_used: Option<Vec<String>>,
    pub created_at: NaiveDateTime,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct PgSidefxGucs {
    pub enabled: Option<bool>,
    pub allowed_databases: Option<String>,
    pub row_include_schemas: Option<String>,
    pub row_exclude_schemas: Option<String>,
    pub log_utility: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExpectDbSideEffectsOptions {
    pub gucs: Option<PgSidefxGucs>,
}

#[derive(Debug, Clone, Default)]
pub struct SummarizeDbSideEffectsOptions {
    pub gucs: Option<PgSidefxGucs>,
    pub snapshots: Option<HashMap<String, String>>,
}

pub type SidefxSnapshotRow = HashMap<String, Value>;
pub type SidefxSnapshotMap = HashMap<String, Option<SidefxSnapshotRow>>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SidefxCapturedQuery {
    pub kind: SidefxQueryKind,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stmt_tag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub indexes_used: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_cascade_related: Option<bool>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SidefxQueryKind {
    Plan,
    Utility,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SidefxRowEvent {
    pub table: String,
    pub operation: String,
    pub is_cascade: bool,
    pub depth: i32,
    pub created_at: NaiveDateTime,
}

#[derive(Debug, Clone)]
pub struct SidefxChangeSummary<T> {
    pub result: T,
    pub before: SidefxSnapshotMap,
    pub after: SidefxSnapshotMap,
    pub side_effects: SideEffectSummary,
    pub utility: UtilitySummary,
    pub tables_changed: Vec<String>,
    pub queries: Vec<SidefxCapturedQuery>,
    pub row_events: Vec<SidefxRowEvent>,
    pub plan_rows: Vec<QueryPlanRow>,
    pub utility_rows: Vec<UtilityLogRow>,
}
