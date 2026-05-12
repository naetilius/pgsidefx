import { expect } from "vitest";
import type { PoolClient } from "pg";

/** `p_from_sql` is used as `FROM ( <p_from_sql> ) t` — must be a valid SELECT/subquery. */
export async function sidefxCount(
  client: PoolClient,
  fromSql: string,
): Promise<number> {
  const { rows } = await client.query<{ c: string }>(
    "SELECT sidefx_count($1::text)::text AS c",
    [fromSql],
  );
  return Number(rows[0].c);
}

export async function assertRowCount(
  client: PoolClient,
  fromSql: string,
  expected: number,
): Promise<void> {
  await client.query(
    "SELECT sidefx_assert_rowcount($1::text, $2::bigint)",
    [fromSql, expected],
  );
}

/** `column` must be a simple identifier (`[a-zA-Z_][a-zA-Z0-9_]*`). */
export async function sidefxSum(
  client: PoolClient,
  fromSql: string,
  column: string,
): Promise<string> {
  const { rows } = await client.query<{ s: string }>(
    "SELECT sidefx_sum($1::text, $2::text)::text AS s",
    [fromSql, column],
  );
  return rows[0].s;
}

export async function assertSumEq(
  client: PoolClient,
  fromSql: string,
  column: string,
  expected: string | number,
): Promise<void> {
  await client.query(
    "SELECT sidefx_assert_sum_eq($1::text, $2::text, $3::numeric)",
    [fromSql, column, String(expected)],
  );
}

/** Subquery must return exactly one row and one numeric column. */
export async function assertNumericEq(
  client: PoolClient,
  fromSql: string,
  expected: string | number,
): Promise<void> {
  await client.query(
    "SELECT sidefx_assert_numeric_eq($1::text, $2::numeric)",
    [fromSql, String(expected)],
  );
}

/** Subquery must return exactly one row and one text column. */
export async function assertTextEq(
  client: PoolClient,
  fromSql: string,
  expected: string,
): Promise<void> {
  await client.query("SELECT sidefx_assert_text_eq($1::text, $2::text)", [
    fromSql,
    expected,
  ]);
}

/** Full SQL statement (e.g. `SELECT …`), without trailing semicolon. */
export async function explainPlanJson(
  client: PoolClient,
  statement: string,
): Promise<unknown> {
  const { rows } = await client.query<{ j: unknown }>(
    "SELECT sidefx_explain_plan_json($1::text) AS j",
    [statement],
  );
  return rows[0].j;
}

export function explainRootPlan(
  explainJson: unknown,
): Record<string, unknown> | null {
  if (!explainJson) return null;
  if (!Array.isArray(explainJson)) return null;
  const first = explainJson[0];
  if (
    first &&
    typeof first === "object" &&
    "Plan" in first &&
    typeof (first as { Plan: unknown }).Plan === "object"
  ) {
    return (first as { Plan: Record<string, unknown> }).Plan;
  }
  return null;
}

export function explainTotalCost(explainJson: unknown): number {
  const plan = explainRootPlan(explainJson);
  const c = plan?.["Total Cost"];
  if (typeof c === "number" && Number.isFinite(c)) return c;
  if (typeof c === "string") {
    const n = Number(c);
    if (Number.isFinite(n)) return n;
  }
  throw new Error("explainTotalCost: missing or invalid Total Cost on plan root");
}

export function walkExplainPlans(
  plan: Record<string, unknown> | null,
  visit: (p: Record<string, unknown>) => void,
): void {
  if (!plan) return;
  visit(plan);
  const kids = plan.Plans;
  if (!Array.isArray(kids)) return;
  for (const k of kids) {
    if (k && typeof k === "object") {
      walkExplainPlans(k as Record<string, unknown>, visit);
    }
  }
}

export function explainIndexNames(explainJson: unknown): string[] {
  const names: string[] = [];
  walkExplainPlans(explainRootPlan(explainJson), (p) => {
    const idx = p["Index Name"];
    if (typeof idx === "string" && idx.length > 0) names.push(idx);
  });
  return names;
}

export function explainNodeTypes(explainJson: unknown): string[] {
  const types: string[] = [];
  walkExplainPlans(explainRootPlan(explainJson), (p) => {
    const t = p["Node Type"];
    if (typeof t === "string") types.push(t);
  });
  return types;
}

export async function expectPlanCostAtMost(
  client: PoolClient,
  statement: string,
  maxTotalCost: number,
): Promise<void> {
  const j = await explainPlanJson(client, statement);
  expect(explainTotalCost(j)).toBeLessThanOrEqual(maxTotalCost);
}

export async function expectExplainUsesIndex(
  client: PoolClient,
  statement: string,
  indexName: string,
): Promise<void> {
  const j = await explainPlanJson(client, statement);
  expect(explainIndexNames(j)).toContain(indexName);
}

export async function expectExplainNodeTypesAbsent(
  client: PoolClient,
  statement: string,
  forbidden: readonly string[],
): Promise<void> {
  const j = await explainPlanJson(client, statement);
  const found = explainNodeTypes(j);
  for (const f of forbidden) {
    expect(found).not.toContain(f);
  }
}

export async function expectNoSeqScanOn(
  client: PoolClient,
  statement: string,
  table: string,
): Promise<void> {
  await client.query(
    "SELECT sidefx_assert_no_seqscan_on($1::text, $2::text)",
    [statement, table],
  );
}

export async function expectIndexUsedFromSet(
  client: PoolClient,
  statement: string,
  indexNames: readonly string[],
): Promise<void> {
  await client.query(
    "SELECT sidefx_assert_index_used_from_set($1::text, $2::text[])",
    [statement, indexNames],
  );
}
