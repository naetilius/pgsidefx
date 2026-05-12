pub(crate) fn is_internal_sidefx_query(sql_text: &str) -> bool {
    let q = sql_text.trim().to_lowercase();
    if q.is_empty() {
        return true;
    }
    q.contains("sidefx_log")
        || q.contains("sidefx_query_plan")
        || q.contains("sidefx_utility_log")
        || q.contains("sidefx_summary(")
        || q.contains("sidefx_utility_summary(")
        || q.contains("sidefx_assert_")
        || q.contains("sidefx_explain_")
        || q.contains("txid_current()::bigint")
}

pub(crate) fn query_touches_table(sql_text: &str, table_fqn: &str) -> bool {
    let q = sql_text.to_lowercase();
    let fqn = table_fqn.to_lowercase();
    let mut parts = fqn.split('.');
    let Some(schema) = parts.next() else {
        return false;
    };
    let Some(table) = parts.next() else {
        return false;
    };
    if schema.is_empty() || table.is_empty() {
        return false;
    }
    let quoted = format!("\"{schema}\".\"{table}\"");
    let unquoted = format!("{schema}.{table}");
    q.contains(&quoted) || q.contains(&unquoted) || q.contains(&format!(" {table} "))
}

pub(crate) fn is_cascade_likely_query(sql_text: &str) -> bool {
    sql_text.trim().to_lowercase().starts_with("delete from only ")
}
