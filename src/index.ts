import { expect } from "vitest";
import type { Pool, PoolClient } from "pg";

export {
  assertNumericEq,
  assertRowCount,
  assertSumEq,
  assertTextEq,
  explainIndexNames,
  explainNodeTypes,
  explainPlanJson,
  explainRootPlan,
  explainTotalCost,
  expectIndexUsedFromSet,
  expectExplainNodeTypesAbsent,
  expectExplainUsesIndex,
  expectNoSeqScanOn,
  expectPlanCostAtMost,
  sidefxCount,
  sidefxSum,
  walkExplainPlans,
} from "./assertions";

export type SideEffectTableStats = {
  inserted?: number;
  updated?: number;
  deleted?: number;
};

export type SideEffectSummary = Record<string, SideEffectTableStats>;

export type UtilityLogRow = {
  id: string | number;
  txid: string | number;
  stmt_tag: string;
  query_text: string | null;
  object_schema: string | null;
  object_type: string | null;
  object_name: string | null;
  correlation_label: string | null;
  created_at: Date;
};

export type UtilitySummary = Record<string, number>;

export type QueryPlanRow = {
  id: string | number;
  txid: string | number;
  query: string | null;
  plan: unknown;
  has_index_scan: boolean;
  indexes_used: string[] | null;
  created_at: Date;
};

export type PgSidefxGucs = {
  /** Master switch for plan + utility hooks (default on). */
  enabled?: boolean;
  /** Comma-separated database names; empty allows all. */
  allowedDatabases?: string;
  /** Comma-separated schemas for row logging only; empty allows all. */
  rowIncludeSchemas?: string;
  /** Comma-separated schemas excluded from row logging. */
  rowExcludeSchemas?: string;
  /** Log DDL / utility statements to `sidefx_utility_log` (default off). */
  logUtility?: boolean;
};

export type ExpectDbSideFxOptions = {
  /** Applied after `BEGIN` using `SET LOCAL` (reverted on `ROLLBACK`). */
  gucs?: PgSidefxGucs;
};

export type SidefxSnapshotRow = Record<string, unknown>;
export type SidefxSnapshotMap = Record<string, SidefxSnapshotRow | null>;

export type SummarizeDbSideEffectsOptions = ExpectDbSideFxOptions & {
  /**
   * Optional named SQL probes executed before and after the action
   * (inside the same transaction). Each query should return 0/1 row.
   */
  snapshots?: Record<string, string>;
};

export type SidefxCapturedQuery = {
  kind: "plan" | "utility";
  text: string;
  stmtTag?: string;
  indexesUsed?: string[];
  isCascadeRelated?: boolean;
};

export type SidefxRowEvent = {
  table: string;
  operation: string;
  isCascade: boolean;
  depth: number;
  createdAt: Date;
};

export type SidefxChangeSummary<TResult> = {
  result: TResult;
  before: SidefxSnapshotMap;
  after: SidefxSnapshotMap;
  sideEffects: SideEffectSummary;
  utility: UtilitySummary;
  tablesChanged: string[];
  queries: SidefxCapturedQuery[];
  rowEvents: SidefxRowEvent[];
  planRows: QueryPlanRow[];
  utilityRows: UtilityLogRow[];
};

function isInternalSidefxQuery(sqlText: string): boolean {
  const q = sqlText.trim().toLowerCase();
  if (!q) return true;
  return (
    q.includes("sidefx_log") ||
    q.includes("sidefx_query_plan") ||
    q.includes("sidefx_utility_log") ||
    q.includes("sidefx_summary(") ||
    q.includes("sidefx_utility_summary(") ||
    q.includes("sidefx_assert_") ||
    q.includes("sidefx_explain_") ||
    q.includes("txid_current()::bigint")
  );
}

function queryTouchesTable(sqlText: string, tableFqn: string): boolean {
  const q = sqlText.toLowerCase();
  const [schema, table] = tableFqn.toLowerCase().split(".");
  if (!schema || !table) return false;
  const quoted = `"${schema}"."${table}"`;
  const unquoted = `${schema}.${table}`;
  return q.includes(quoted) || q.includes(unquoted) || q.includes(` ${table} `);
}

function isCascadeLikelyQuery(sqlText: string): boolean {
  const q = sqlText.trim().toLowerCase();
  return q.startsWith("delete from only ");
}

export class PgSideFx {
  private constructor(
    private readonly pool: Pick<Pool, "connect">,
    private readonly baseOptions?: ExpectDbSideFxOptions,
  ) {}

  static init(
    pool: Pick<Pool, "connect">,
    options?: ExpectDbSideFxOptions,
  ): PgSideFx {
    return new PgSideFx(pool, options);
  }

  private mergedOptions(
    options?: ExpectDbSideFxOptions,
  ): ExpectDbSideFxOptions | undefined {
    if (!this.baseOptions && !options) return undefined;
    return {
      gucs: {
        ...(this.baseOptions?.gucs ?? {}),
        ...(options?.gucs ?? {}),
      },
    };
  }

  private async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  async ensureExtension(): Promise<void> {
    await this.withClient(async (client) => {
      await client.query("CREATE EXTENSION IF NOT EXISTS pg_sidefx");
    });
  }

  async attachTable(tableFqn: string): Promise<void> {
    await this.withClient(async (client) => {
      await client.query("SELECT sidefx_attach($1::regclass)", [tableFqn]);
    });
  }

  async attachTables(tableFqns: readonly string[]): Promise<void> {
    await this.withClient(async (client) => {
      for (const t of tableFqns) {
        await client.query("SELECT sidefx_attach($1::regclass)", [t]);
      }
    });
  }

  async expect(
    fn: (client: PoolClient) => Promise<void>,
    options?: ExpectDbSideFxOptions,
  ): Promise<SideEffectAssertion> {
    return this.withClient(async (client) =>
      expectDbSideEffects(
        client,
        async () => {
          await fn(client);
        },
        this.mergedOptions(options),
      ),
    );
  }

  async summarize<TResult>(
    fn: (client: PoolClient) => Promise<TResult>,
    options?: SummarizeDbSideEffectsOptions,
  ): Promise<SidefxChangeSummary<TResult>> {
    return this.withClient(async (client) =>
      summarizeDbSideEffects(
        client,
        async () => fn(client),
        {
          ...options,
          ...this.mergedOptions(options),
        },
      ),
    );
  }
}

function escSqlString(s: string): string {
  return s.replace(/'/g, "''");
}

/** Apply `pg_sidefx.*` session settings using `SET LOCAL` (transaction-scoped). */
export async function applyPgSidefxGucs(
  client: PoolClient,
  gucs: PgSidefxGucs,
): Promise<void> {
  if (gucs.enabled !== undefined) {
    await client.query(
      `SET LOCAL pg_sidefx.enabled = ${gucs.enabled ? "on" : "off"}`,
    );
  }
  if (gucs.allowedDatabases !== undefined) {
    await client.query(
      `SET LOCAL pg_sidefx.allowed_databases = '${escSqlString(gucs.allowedDatabases)}'`,
    );
  }
  if (gucs.rowIncludeSchemas !== undefined) {
    await client.query(
      `SET LOCAL pg_sidefx.row_include_schemas = '${escSqlString(gucs.rowIncludeSchemas)}'`,
    );
  }
  if (gucs.rowExcludeSchemas !== undefined) {
    await client.query(
      `SET LOCAL pg_sidefx.row_exclude_schemas = '${escSqlString(gucs.rowExcludeSchemas)}'`,
    );
  }
  if (gucs.logUtility !== undefined) {
    await client.query(
      `SET LOCAL pg_sidefx.log_utility = ${gucs.logUtility ? "on" : "off"}`,
    );
  }
}

export class SideEffectAssertion {
  constructor(
    readonly summary: SideEffectSummary,
    readonly planRows: QueryPlanRow[],
    readonly utilityRows: UtilityLogRow[],
    readonly utilitySummary: UtilitySummary,
  ) {}

  toMatch(expected: SideEffectSummary): void {
    expect(this.summary).toMatchObject(expected);
  }

  utilitiesToMatch(expected: UtilitySummary): void {
    expect(this.utilitySummary).toMatchObject(expected);
  }

  usedIndex(indexName: string): void {
    const found = this.planRows.some((p) =>
      (p.indexes_used ?? []).includes(indexName),
    );
    expect(found).toBe(true);
  }

  onlyAffectedTables(expectedTables: readonly string[]): void {
    const actual = Object.keys(this.summary).sort();
    const expected = [...expectedTables].sort();
    expect(actual).toEqual(expected);
  }

  notAffectedTables(tables: readonly string[]): void {
    const affected = new Set(Object.keys(this.summary));
    for (const t of tables) {
      expect(affected.has(t)).toBe(false);
    }
  }

  // Alias forms for teams that prefer assertion-style PascalCase names.
  OnlyAffectedTables(expectedTables: readonly string[]): void {
    this.onlyAffectedTables(expectedTables);
  }

  NotAffectedTables(tables: readonly string[]): void {
    this.notAffectedTables(tables);
  }

  private planHaystack(rows: QueryPlanRow[] = this.planRows): string {
    return rows
      .map((p) =>
        typeof p.plan === "string" ? p.plan : JSON.stringify(p.plan),
      )
      .join("\n");
  }

  /**
   * Only inspects captured plans for statements that look like `SELECT` queries.
   * DML plans (for example `INSERT`/`UPDATE` heap paths) often include `SeqScan`
   * on the target table even when read queries use indexes.
   *
   * Plans for `SELECT count(*)` / `SELECT coalesce(sum…)` wrappers (used by SQL
   * invariant helpers) are ignored so they do not mask application `SELECT`s.
   */
  noSeqScan(table: string): void {
    const selectPlans = this.planRows.filter((p) => {
      const q = (p.query ?? "").trim();
      return (
        /^\s*select\b/i.test(q) &&
        /* ignore aggregate scans from sidefx_count / assertRowCount internals */
        !/^\s*select\s+count\s*\(/i.test(q) &&
        /* ignore sidefx_sum / assertSumEq aggregate wrapper */
        !/^\s*select\s+coalesce\b/i.test(q)
      );
    });
    const haystack = this.planHaystack(selectPlans);
    const hasSeqOnTable =
      haystack.includes("SeqScan") &&
      haystack.includes(`"relation":"${table}"`);
    expect(hasSeqOnTable).toBe(false);
  }
}

export async function expectDbSideEffects(
  client: PoolClient,
  fn: () => Promise<void>,
  options?: ExpectDbSideFxOptions,
): Promise<SideEffectAssertion> {
  await client.query("BEGIN");

  if (options?.gucs) {
    await applyPgSidefxGucs(client, options.gucs);
  }

  await client.query("DELETE FROM sidefx_log");
  await client.query("DELETE FROM sidefx_query_plan");
  await client.query("DELETE FROM sidefx_utility_log");

  await fn();

  const assertion = await collectCurrentTxSidefx(client);

  await client.query("ROLLBACK");

  return assertion;
}

async function collectCurrentTxSidefx(
  client: PoolClient,
): Promise<SideEffectAssertion> {

  const { rows: summaryRows } = await client.query<{
    sidefx_summary: unknown;
  }>("SELECT sidefx_summary(txid_current()::bigint) AS sidefx_summary");

  const summary = (summaryRows[0]?.sidefx_summary ?? {}) as SideEffectSummary;

  const { rows: planRows } = await client.query<QueryPlanRow>(
    "SELECT * FROM sidefx_query_plan WHERE txid = txid_current()::bigint",
  );

  const { rows: utilityRows } = await client.query<UtilityLogRow>(
    "SELECT * FROM sidefx_utility_log WHERE txid = txid_current()::bigint ORDER BY id",
  );

  const { rows: utilSummaryRows } = await client.query<{
    sidefx_utility_summary: unknown;
  }>(
    "SELECT sidefx_utility_summary(txid_current()::bigint) AS sidefx_utility_summary",
  );

  const utilitySummary = (utilSummaryRows[0]?.sidefx_utility_summary ??
    {}) as UtilitySummary;
  return new SideEffectAssertion(summary, planRows, utilityRows, utilitySummary);
}

async function runSnapshots(
  client: PoolClient,
  snapshots?: Record<string, string>,
): Promise<SidefxSnapshotMap> {
  if (!snapshots) return {};
  const out: SidefxSnapshotMap = {};
  for (const [name, sql] of Object.entries(snapshots)) {
    const { rows } = await client.query<SidefxSnapshotRow>(sql);
    out[name] = rows[0] ?? null;
  }
  return out;
}

/**
 * Wrap an action and return one structured object with:
 * - action result
 * - before/after snapshots
 * - side-effect summaries
 * - changed tables and captured queries
 */
export async function summarizeDbSideEffects<TResult>(
  client: PoolClient,
  fn: () => Promise<TResult>,
  options?: SummarizeDbSideEffectsOptions,
): Promise<SidefxChangeSummary<TResult>> {
  await client.query("BEGIN");
  try {
    if (options?.gucs) {
      await applyPgSidefxGucs(client, options.gucs);
    }

    await client.query("DELETE FROM sidefx_log");
    await client.query("DELETE FROM sidefx_query_plan");
    await client.query("DELETE FROM sidefx_utility_log");

    const before = await runSnapshots(client, options?.snapshots);
    const result = await fn();
    const after = await runSnapshots(client, options?.snapshots);

    const assertion = await collectCurrentTxSidefx(client);
    const { rows: rawRowEvents } = await client.query<{
      table_schema: string;
      table_name: string;
      operation: string;
      is_cascade: boolean;
      depth: number;
      created_at: Date;
    }>(
      `SELECT table_schema, table_name, operation, is_cascade, depth, created_at
       FROM sidefx_log
       WHERE txid = txid_current()::bigint
       ORDER BY id`,
    );

    const rowEvents: SidefxRowEvent[] = rawRowEvents.map((r) => ({
      table: `${r.table_schema}.${r.table_name}`,
      operation: r.operation,
      isCascade: Boolean(r.is_cascade),
      depth: r.depth,
      createdAt: r.created_at,
    }));
    const cascadeTables = new Set(
      rowEvents.filter((e) => e.isCascade).map((e) => e.table),
    );
    const planRows = assertion.planRows.filter(
      (row) => !isInternalSidefxQuery(row.query ?? ""),
    );
    const utilityRows = assertion.utilityRows.filter(
      (row) => !isInternalSidefxQuery(row.query_text ?? ""),
    );

    const tablesChanged = Object.keys(assertion.summary).sort();
    const queries: SidefxCapturedQuery[] = [
      ...planRows
        .map((row) => ({
          kind: "plan" as const,
          text: row.query ?? "",
          indexesUsed: row.indexes_used ?? [],
          isCascadeRelated:
            isCascadeLikelyQuery(row.query ?? "") ||
            Array.from(cascadeTables).some((t) =>
              queryTouchesTable(row.query ?? "", t),
            ),
        }))
        .filter((q) => q.text.trim().length > 0),
      ...utilityRows
        .map((row) => ({
          kind: "utility" as const,
          text: row.query_text ?? "",
          stmtTag: row.stmt_tag,
          isCascadeRelated: Array.from(cascadeTables).some((t) =>
            queryTouchesTable(row.query_text ?? "", t),
          ),
        }))
        .filter((q) => q.text.trim().length > 0),
    ];

    await client.query("ROLLBACK");
    return {
      result,
      before,
      after,
      sideEffects: assertion.summary,
      utility: assertion.utilitySummary,
      tablesChanged,
      queries,
      rowEvents,
      planRows,
      utilityRows,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}
