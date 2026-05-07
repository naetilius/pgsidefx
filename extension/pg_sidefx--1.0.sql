/*
 * pg_sidefx — transaction-scoped side-effect auditing.
 *
 * Session GUCs (set with SET / SET LOCAL; see docs/unintended-side-effects.md):
 *   pg_sidefx.enabled              — master switch (default on)
 *   pg_sidefx.allowed_databases    — comma list; empty = all databases
 *   pg_sidefx.row_include_schemas  — comma list; empty = all schemas for row log
 *   pg_sidefx.row_exclude_schemas  — comma list; excluded schemas skip row log
 *   pg_sidefx.log_utility          — log DDL / utility statements (default off)
 */

CREATE TABLE sidefx_log (
  id BIGSERIAL PRIMARY KEY,
  txid BIGINT,
  table_schema TEXT NOT NULL,
  table_name TEXT NOT NULL,
  operation TEXT,
  row_before JSONB,
  row_after JSONB,
  is_cascade BOOLEAN,
  trigger_name TEXT,
  depth INT,
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE sidefx_query_plan (
  id BIGSERIAL PRIMARY KEY,
  txid BIGINT,
  query TEXT,
  plan JSONB,
  has_index_scan BOOLEAN,
  indexes_used TEXT[],
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE sidefx_utility_log (
  id BIGSERIAL PRIMARY KEY,
  txid BIGINT,
  stmt_tag TEXT NOT NULL,
  query_text TEXT,
  object_schema TEXT,
  object_type TEXT,
  object_name TEXT,
  correlation_label TEXT,
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE sidefx_tx_label (
  txid BIGINT PRIMARY KEY,
  label TEXT NOT NULL,
  started_at TIMESTAMP DEFAULT now(),
  ended_at TIMESTAMP
);

CREATE TABLE sidefx_export_queue (
  id BIGSERIAL PRIMARY KEY,
  txid BIGINT NOT NULL,
  label TEXT,
  payload JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT now(),
  delivered_at TIMESTAMP
);

CREATE OR REPLACE FUNCTION sidefx_capture()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  inc text;
  exc text;
  sch text := TG_TABLE_SCHEMA;
BEGIN
  inc := NULLIF(btrim(current_setting('pg_sidefx.row_include_schemas', true)), '');
  IF inc IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM regexp_split_to_table(inc, '\s*,\s*') AS sch_cand
      WHERE sch_cand = sch
    ) THEN
      RETURN COALESCE(NEW, OLD);
    END IF;
  END IF;

  exc := NULLIF(btrim(current_setting('pg_sidefx.row_exclude_schemas', true)), '');
  IF exc IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
      FROM regexp_split_to_table(exc, '\s*,\s*') AS sch_cand
      WHERE sch_cand = sch
    ) THEN
      RETURN COALESCE(NEW, OLD);
    END IF;
  END IF;

  INSERT INTO sidefx_log (
    txid,
    table_schema,
    table_name,
    operation,
    row_before,
    row_after,
    is_cascade,
    trigger_name,
    depth
  )
  VALUES (
    txid_current()::bigint,
    sch,
    TG_TABLE_NAME,
    TG_OP,
    CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) ELSE NULL END,
    CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) ELSE NULL END,
    pg_trigger_depth() > 1,
    TG_NAME,
    pg_trigger_depth()
  );

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION sidefx_summary(p_txid BIGINT)
RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
SELECT COALESCE(
  (
    SELECT jsonb_object_agg(qual_table, stats)
    FROM (
      SELECT format('%s.%s', table_schema, table_name) AS qual_table,
             jsonb_build_object(
               'inserted', count(*) FILTER (WHERE operation = 'INSERT'),
               'updated', count(*) FILTER (WHERE operation = 'UPDATE'),
               'deleted', count(*) FILTER (WHERE operation = 'DELETE')
             ) AS stats
      FROM sidefx_log
      WHERE txid = p_txid
      GROUP BY table_schema, table_name
    ) t
  ),
  '{}'::jsonb
);
$$;

CREATE OR REPLACE FUNCTION sidefx_utility_summary(p_txid BIGINT)
RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
SELECT COALESCE(
  (
    SELECT jsonb_object_agg(stmt_tag, cnt)
    FROM (
      SELECT stmt_tag, count(*)::bigint AS cnt
      FROM sidefx_utility_log
      WHERE txid = p_txid
      GROUP BY stmt_tag
    ) u
  ),
  '{}'::jsonb
);
$$;

CREATE OR REPLACE FUNCTION sidefx_begin(p_label text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_label IS NULL OR btrim(p_label) = '' THEN
    RAISE EXCEPTION 'sidefx_begin: label is required';
  END IF;

  INSERT INTO sidefx_tx_label (txid, label, started_at, ended_at)
  VALUES (txid_current()::bigint, p_label, now(), NULL)
  ON CONFLICT (txid) DO UPDATE
  SET label = EXCLUDED.label,
      started_at = sidefx_tx_label.started_at,
      ended_at = NULL;
END;
$$;

CREATE OR REPLACE FUNCTION sidefx_end()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_txid bigint := txid_current()::bigint;
  v_label text;
BEGIN
  SELECT label
  INTO v_label
  FROM sidefx_tx_label
  WHERE txid = v_txid
  LIMIT 1;

  UPDATE sidefx_tx_label
  SET ended_at = COALESCE(ended_at, now())
  WHERE txid = v_txid;

  INSERT INTO sidefx_export_queue (txid, label, payload)
  VALUES (
    v_txid,
    v_label,
    jsonb_build_object(
      'txid', v_txid,
      'label', v_label,
      'summary', sidefx_summary(v_txid),
      'utility_summary', sidefx_utility_summary(v_txid),
      'created_at', now()
    )
  );
END;
$$;

CREATE OR REPLACE VIEW sidefx_recent_changes AS
SELECT
  txid,
  created_at,
  format('%s.%s', table_schema, table_name) AS table_fqn,
  operation,
  is_cascade,
  depth,
  trigger_name
FROM sidefx_log
ORDER BY created_at DESC, id DESC;

CREATE OR REPLACE VIEW sidefx_top_tables AS
SELECT
  format('%s.%s', table_schema, table_name) AS table_fqn,
  count(*)::bigint AS total_events,
  count(*) FILTER (WHERE operation = 'INSERT')::bigint AS inserted,
  count(*) FILTER (WHERE operation = 'UPDATE')::bigint AS updated,
  count(*) FILTER (WHERE operation = 'DELETE')::bigint AS deleted,
  max(created_at) AS last_seen_at
FROM sidefx_log
GROUP BY table_schema, table_name
ORDER BY total_events DESC, table_fqn;

CREATE OR REPLACE FUNCTION sidefx_tx_timeline(p_txid bigint)
RETURNS TABLE(
  event_at timestamp,
  event_kind text,
  table_fqn text,
  operation text,
  stmt_tag text,
  correlation_label text,
  details jsonb
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    l.created_at AS event_at,
    'row'::text AS event_kind,
    format('%s.%s', l.table_schema, l.table_name) AS table_fqn,
    l.operation,
    NULL::text AS stmt_tag,
    tx.label AS correlation_label,
    jsonb_build_object(
      'is_cascade', l.is_cascade,
      'depth', l.depth,
      'trigger_name', l.trigger_name
    ) AS details
  FROM sidefx_log l
  LEFT JOIN sidefx_tx_label tx ON tx.txid = l.txid
  WHERE l.txid = p_txid

  UNION ALL

  SELECT
    u.created_at AS event_at,
    'utility'::text AS event_kind,
    CASE
      WHEN u.object_name IS NULL THEN NULL
      WHEN u.object_schema IS NULL THEN u.object_name
      ELSE format('%s.%s', u.object_schema, u.object_name)
    END AS table_fqn,
    NULL::text AS operation,
    u.stmt_tag,
    u.correlation_label,
    jsonb_build_object(
      'object_type', u.object_type,
      'query_text', u.query_text
    ) AS details
  FROM sidefx_utility_log u
  WHERE u.txid = p_txid

  UNION ALL

  SELECT
    tx.started_at AS event_at,
    'begin'::text AS event_kind,
    NULL::text AS table_fqn,
    NULL::text AS operation,
    NULL::text AS stmt_tag,
    tx.label AS correlation_label,
    jsonb_build_object('txid', tx.txid) AS details
  FROM sidefx_tx_label tx
  WHERE tx.txid = p_txid

  UNION ALL

  SELECT
    tx.ended_at AS event_at,
    'end'::text AS event_kind,
    NULL::text AS table_fqn,
    NULL::text AS operation,
    NULL::text AS stmt_tag,
    tx.label AS correlation_label,
    jsonb_build_object('txid', tx.txid) AS details
  FROM sidefx_tx_label tx
  WHERE tx.txid = p_txid AND tx.ended_at IS NOT NULL

  ORDER BY event_at ASC NULLS LAST;
$$;

/*
 * Invariant helpers (dynamic SQL — use only from trusted tests / dev DB).
 * p_from_sql is wrapped as a subquery: FROM ( <p_from_sql> ) t
 * p_statement is appended after EXPLAIN (FORMAT JSON)
 */

CREATE OR REPLACE FUNCTION sidefx_count(p_from_sql text)
RETURNS bigint
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  c bigint;
BEGIN
  EXECUTE 'SELECT count(*)::bigint FROM (' || p_from_sql || ') t' INTO c;
  RETURN c;
END;
$$;

CREATE OR REPLACE FUNCTION sidefx_assert_rowcount(p_from_sql text, p_expected bigint)
RETURNS void
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  c bigint;
BEGIN
  c := sidefx_count(p_from_sql);
  IF c IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'sidefx_assert_rowcount: expected %, got % (from: %)',
      p_expected, c, left(p_from_sql, 400);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION sidefx_sum(p_from_sql text, p_column text)
RETURNS numeric
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  s numeric;
BEGIN
  IF p_column !~ '^[a-zA-Z_][a-zA-Z0-9_]*$' THEN
    RAISE EXCEPTION 'sidefx_sum: invalid column name %', p_column;
  END IF;
  EXECUTE 'SELECT coalesce(sum(' || quote_ident(p_column) || '), 0)::numeric FROM (' ||
          p_from_sql || ') t' INTO s;
  RETURN s;
END;
$$;

CREATE OR REPLACE FUNCTION sidefx_assert_sum_eq(p_from_sql text, p_column text, p_expected numeric)
RETURNS void
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  s numeric;
BEGIN
  s := sidefx_sum(p_from_sql, p_column);
  IF s IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'sidefx_assert_sum_eq: expected sum(%) = %, got % (from: %)',
      p_column, p_expected, s, left(p_from_sql, 400);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION sidefx_fetch_one_numeric(p_from_sql text)
RETURNS numeric
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v numeric;
  n bigint;
BEGIN
  EXECUTE 'SELECT count(*)::bigint FROM (' || p_from_sql || ') __sidefx_sq' INTO STRICT n;
  IF n <> 1 THEN
    RAISE EXCEPTION 'sidefx_fetch_one_numeric: expected exactly 1 row, got % (from: %)',
      n, left(p_from_sql, 400);
  END IF;
  EXECUTE 'SELECT * FROM (' || p_from_sql || ') __sidefx_sq' INTO STRICT v;
  RETURN v;
END;
$$;

CREATE OR REPLACE FUNCTION sidefx_assert_numeric_eq(p_from_sql text, p_expected numeric)
RETURNS void
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v numeric;
BEGIN
  v := sidefx_fetch_one_numeric(p_from_sql);
  IF v IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'sidefx_assert_numeric_eq: expected %, got % (from: %)',
      p_expected, v, left(p_from_sql, 400);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION sidefx_fetch_one_text(p_from_sql text)
RETURNS text
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v text;
  n bigint;
BEGIN
  EXECUTE 'SELECT count(*)::bigint FROM (' || p_from_sql || ') __sidefx_sq' INTO STRICT n;
  IF n <> 1 THEN
    RAISE EXCEPTION 'sidefx_fetch_one_text: expected exactly 1 row, got % (from: %)',
      n, left(p_from_sql, 400);
  END IF;
  EXECUTE 'SELECT * FROM (' || p_from_sql || ') __sidefx_sq' INTO STRICT v;
  RETURN v;
END;
$$;

CREATE OR REPLACE FUNCTION sidefx_assert_text_eq(p_from_sql text, p_expected text)
RETURNS void
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v text;
BEGIN
  v := sidefx_fetch_one_text(p_from_sql);
  IF v IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'sidefx_assert_text_eq: expected %, got % (from: %)',
      p_expected, v, left(p_from_sql, 400);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION sidefx_explain_plan_json(p_statement text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  j json;
BEGIN
  EXECUTE 'EXPLAIN (FORMAT JSON) ' || p_statement INTO STRICT j;
  RETURN j::jsonb;
END;
$$;

CREATE OR REPLACE FUNCTION sidefx_assert_no_seqscan_on(p_statement text, p_table text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  has_seqscan boolean;
BEGIN
  WITH RECURSIVE nodes(node) AS (
    SELECT (j->0->'Plan')
    FROM (SELECT sidefx_explain_plan_json(p_statement) AS j) q
    UNION ALL
    SELECT child
    FROM nodes n
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(n.node->'Plans', '[]'::jsonb)) child
  )
  SELECT EXISTS (
    SELECT 1
    FROM nodes
    WHERE node->>'Node Type' = 'Seq Scan'
      AND COALESCE(node->>'Relation Name', node->>'relation') = p_table
  )
  INTO has_seqscan;

  IF has_seqscan THEN
    RAISE EXCEPTION 'sidefx_assert_no_seqscan_on: found Seq Scan on % (statement: %)',
      p_table, left(p_statement, 400);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION sidefx_assert_index_used_from_set(p_statement text, p_index_names text[])
RETURNS void
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  found_index text;
BEGIN
  WITH RECURSIVE nodes(node) AS (
    SELECT (j->0->'Plan')
    FROM (SELECT sidefx_explain_plan_json(p_statement) AS j) q
    UNION ALL
    SELECT child
    FROM nodes n
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(n.node->'Plans', '[]'::jsonb)) child
  )
  SELECT COALESCE(node->>'Index Name', node->>'index')
  INTO found_index
  FROM nodes
  WHERE COALESCE(node->>'Index Name', node->>'index') = ANY(p_index_names)
  LIMIT 1;

  IF found_index IS NULL THEN
    RAISE EXCEPTION 'sidefx_assert_index_used_from_set: expected one of %, statement: %',
      p_index_names, left(p_statement, 400);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION sidefx_attach(p_table regclass)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  fqname text := p_table::text;
  ext_nsp name;
BEGIN
  SELECT n.nspname
    INTO STRICT ext_nsp
  FROM pg_extension e
  JOIN pg_namespace n ON n.oid = e.extnamespace
  WHERE e.extname = 'pg_sidefx';

  EXECUTE format('DROP TRIGGER IF EXISTS sidefx_row_capture ON %s', fqname);
  EXECUTE format(
    'CREATE TRIGGER sidefx_row_capture
       AFTER INSERT OR UPDATE OR DELETE ON %s
       FOR EACH ROW
       EXECUTE FUNCTION %I.sidefx_capture()',
    fqname,
    ext_nsp
  );
END;
$$;

CREATE OR REPLACE FUNCTION sidefx_loader()
RETURNS void
LANGUAGE C
AS 'MODULE_PATHNAME', 'sidefx_loader'
STRICT;

SELECT sidefx_loader();
