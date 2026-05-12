use tokio_postgres::Client;

use crate::error::PgSidefxError;

/// `from_sql` is used as `FROM ( <from_sql> ) t` — must be a valid SELECT/subquery.
pub async fn sidefx_count(client: &Client, from_sql: &str) -> Result<i64, PgSidefxError> {
    let row = client
        .query_one(
            "SELECT sidefx_count($1::text)::text AS c",
            &[&from_sql],
        )
        .await?;
    let c: String = row.get(0);
    c.parse::<i64>()
        .map_err(|_| PgSidefxError::AssertionFailed(format!("sidefx_count: invalid int {c:?}")))
}

pub async fn assert_row_count(
    client: &Client,
    from_sql: &str,
    expected: i64,
) -> Result<(), PgSidefxError> {
    client
        .execute(
            "SELECT sidefx_assert_rowcount($1::text, $2::bigint)",
            &[&from_sql, &expected],
        )
        .await?;
    Ok(())
}

/// `column` must be a simple identifier (`[a-zA-Z_][a-zA-Z0-9_]*`).
pub async fn sidefx_sum(
    client: &Client,
    from_sql: &str,
    column: &str,
) -> Result<String, PgSidefxError> {
    let row = client
        .query_one(
            "SELECT sidefx_sum($1::text, $2::text)::text AS s",
            &[&from_sql, &column],
        )
        .await?;
    Ok(row.get(0))
}

pub async fn assert_sum_eq(
    client: &Client,
    from_sql: &str,
    column: &str,
    expected: &str,
) -> Result<(), PgSidefxError> {
    client
        .execute(
            "SELECT sidefx_assert_sum_eq($1::text, $2::text, $3::numeric)",
            &[&from_sql, &column, &expected],
        )
        .await?;
    Ok(())
}

pub async fn assert_numeric_eq(
    client: &Client,
    from_sql: &str,
    expected: &str,
) -> Result<(), PgSidefxError> {
    client
        .execute(
            "SELECT sidefx_assert_numeric_eq($1::text, $2::numeric)",
            &[&from_sql, &expected],
        )
        .await?;
    Ok(())
}

pub async fn assert_text_eq(
    client: &Client,
    from_sql: &str,
    expected: &str,
) -> Result<(), PgSidefxError> {
    client
        .execute(
            "SELECT sidefx_assert_text_eq($1::text, $2::text)",
            &[&from_sql, &expected],
        )
        .await?;
    Ok(())
}

/// Full SQL statement (e.g. `SELECT …`), without trailing semicolon.
pub async fn explain_plan_json(
    client: &Client,
    statement: &str,
) -> Result<serde_json::Value, PgSidefxError> {
    let row = client
        .query_one("SELECT sidefx_explain_plan_json($1::text) AS j", &[&statement])
        .await?;
    Ok(row.get(0))
}

pub fn explain_root_plan(
    explain_json: &serde_json::Value,
) -> Option<serde_json::Map<String, serde_json::Value>> {
    let arr = explain_json.as_array()?;
    let first = arr.first()?.as_object()?;
    let plan = first.get("Plan")?;
    plan.as_object().cloned()
}

pub fn explain_total_cost(explain_json: &serde_json::Value) -> Result<f64, PgSidefxError> {
    let plan = explain_root_plan(explain_json).ok_or(PgSidefxError::InvalidExplainCost)?;
    let c = plan.get("Total Cost").ok_or(PgSidefxError::InvalidExplainCost)?;
    match c {
        serde_json::Value::Number(n) => n
            .as_f64()
            .ok_or(PgSidefxError::InvalidExplainCost),
        serde_json::Value::String(s) => s
            .parse::<f64>()
            .map_err(|_| PgSidefxError::InvalidExplainCost),
        _ => Err(PgSidefxError::InvalidExplainCost),
    }
}

pub fn walk_explain_plans(
    plan: &serde_json::Map<String, serde_json::Value>,
    visit: &mut dyn FnMut(&serde_json::Map<String, serde_json::Value>),
) {
    visit(plan);
    let Some(serde_json::Value::Array(kids)) = plan.get("Plans") else {
        return;
    };
    for k in kids {
        if let serde_json::Value::Object(m) = k {
            walk_explain_plans(m, visit);
        }
    }
}

pub fn explain_index_names(explain_json: &serde_json::Value) -> Vec<String> {
    let mut names = Vec::new();
    if let Some(root) = explain_root_plan(explain_json) {
        walk_explain_plans(&root, &mut |p| {
            if let Some(serde_json::Value::String(idx)) = p.get("Index Name") {
                if !idx.is_empty() {
                    names.push(idx.clone());
                }
            }
        });
    }
    names
}

pub fn explain_node_types(explain_json: &serde_json::Value) -> Vec<String> {
    let mut types = Vec::new();
    if let Some(root) = explain_root_plan(explain_json) {
        walk_explain_plans(&root, &mut |p| {
            if let Some(serde_json::Value::String(t)) = p.get("Node Type") {
                types.push(t.clone());
            }
        });
    }
    types
}

pub async fn expect_plan_cost_at_most(
    client: &Client,
    statement: &str,
    max_total_cost: f64,
) -> Result<(), PgSidefxError> {
    let j = explain_plan_json(client, statement).await?;
    let cost = explain_total_cost(&j)?;
    assert!(
        cost <= max_total_cost,
        "plan cost {cost} exceeds max {max_total_cost}"
    );
    Ok(())
}

pub async fn expect_explain_uses_index(
    client: &Client,
    statement: &str,
    index_name: &str,
) -> Result<(), PgSidefxError> {
    let j = explain_plan_json(client, statement).await?;
    let names = explain_index_names(&j);
    assert!(
        names.iter().any(|n| n == index_name),
        "expected index {index_name:?} in {names:?}"
    );
    Ok(())
}

pub async fn expect_explain_node_types_absent(
    client: &Client,
    statement: &str,
    forbidden: &[&str],
) -> Result<(), PgSidefxError> {
    let j = explain_plan_json(client, statement).await?;
    let found = explain_node_types(&j);
    for f in forbidden {
        assert!(
            !found.iter().any(|t| t == f),
            "forbidden node type {f:?} present in {found:?}"
        );
    }
    Ok(())
}

pub async fn expect_no_seq_scan_on(
    client: &Client,
    statement: &str,
    table: &str,
) -> Result<(), PgSidefxError> {
    client
        .execute(
            "SELECT sidefx_assert_no_seqscan_on($1::text, $2::text)",
            &[&statement, &table],
        )
        .await?;
    Ok(())
}

pub async fn expect_index_used_from_set(
    client: &Client,
    statement: &str,
    index_names: &[String],
) -> Result<(), PgSidefxError> {
    let refs: Vec<&str> = index_names.iter().map(String::as_str).collect();
    client
        .execute(
            "SELECT sidefx_assert_index_used_from_set($1::text, $2::text[])",
            &[&statement, &refs],
        )
        .await?;
    Ok(())
}
