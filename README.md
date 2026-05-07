# pg_sidefx

`pg_sidefx` is a PostgreSQL extension + TypeScript test helper toolkit for verifying **what your API call changed in the database**.

It captures:
- row-level side effects (insert/update/delete) on attached tables
- captured query plans and index usage
- utility/DDL activity (optional)
- transaction summaries suitable for integration tests

---

## Why this exists

Integration tests usually assert API output, but miss hidden DB behavior:
- writes to unexpected tables
- cascade chains
- seq scans or missed indexes
- DDL side effects

`pg_sidefx` lets you wrap an action and assert the DB effects in one place.

---

## Features

- **Row side-effect summary** per table (`inserted`, `updated`, `deleted`)
- **Plan capture** with `indexes_used`, `has_index_scan`, raw plan JSON
- **Utility log** capture with statement tags (`COMMENT`, etc.)
- **Before/after summary API** via `summarizeDbSideEffects(...)`
- **SQL assertion helpers** for row counts, sums, explain checks
- **Jest-friendly assertion object** (`toMatch`, `usedIndex`, `noSeqScan`)

---

## Quick start

### 1) Install dependencies

```bash
npm install
```

### 2) Run tests

```bash
npm test
```

The integration tests use `testcontainers` and build from the repo `Dockerfile`.

---

## Core TypeScript APIs

From `src/index.ts`:

- `PgSideFx.init(pool, options?)`
  - OOP wrapper over `pg.Pool`
  - methods: `ensureExtension`, `attachTable(s)`, `expect`, `summarize`

- `expectDbSideEffects(client, action, options?)`
  - runs `action` in a transaction
  - captures side effects, plans, utilities
  - returns `SideEffectAssertion`

- `summarizeDbSideEffects(client, action, options?)`
  - returns one structured report with:
    - `result`
    - `before`/`after` snapshot probes
    - `sideEffects`
    - `utility`
    - `tablesChanged`
    - `queries`
    - raw `planRows` and `utilityRows`

- Helper assertions:
  - `assertRowCount`, `assertSumEq`, `assertNumericEq`, `assertTextEq`
  - `expectExplainUsesIndex`, `expectExplainNodeTypesAbsent`
  - `expectNoSeqScanOn`, `expectIndexUsedFromSet`

---

## Usage pattern: business call -> assert DB -> assert output

```ts
import pg from "pg";
import { expectDbSideEffects } from "./src";

type Car = { id: number; personId: number; plate: string };
class CarService {
  constructor(private readonly client: pg.PoolClient) {}

  async createCar(input: { personId: number; plate: string }): Promise<Car> {
    const { rows } = await this.client.query<{ id: string }>(
      `INSERT INTO cascade_demo.car (person_id, plate)
       VALUES ($1, $2)
       RETURNING id`,
      [input.personId, input.plate],
    );
    return {
      id: Number(rows[0].id),
      personId: input.personId,
      plate: input.plate,
    };
  }
}

async function testCreateCar() {
  const pool = new pg.Pool({
    host: "localhost",
    port: 5432,
    user: "test",
    password: "test",
    database: "test",
  });
  const client = await pool.connect();

  try {
    await client.query("CREATE EXTENSION IF NOT EXISTS pg_sidefx");
    await client.query("SELECT sidefx_attach('cascade_demo.car'::regclass)");

    let result: Car | null = null;
    const sidefx = await expectDbSideEffects(
      client,
      async () => {
        const carService = new CarService(client);
        result = await carService.createCar({ personId: 42, plate: "AAA-1" });
      },
      { gucs: { allowedDatabases: "test" } },
    );

    // Assert DB changes
    sidefx.toMatch({ "cascade_demo.car": { inserted: 1 } });

    // Assert output
    if (!result) throw new Error("expected createCar result");
    if (result.plate !== "AAA-1") throw new Error("wrong plate");
  } finally {
    client.release();
    await pool.end();
  }
}
```

---

## Usage pattern: full structured report

```ts
import { summarizeDbSideEffects } from "./src";

const report = await summarizeDbSideEffects(
  client,
  async () => {
    const carService = new CarService(client);
    return carService.createCar({ personId: 42, plate: "AAA-1" });
  },
  {
    gucs: { allowedDatabases: "test", logUtility: true },
    snapshots: {
      cars: "SELECT count(*)::bigint AS count FROM cascade_demo.car",
    },
  },
);

// output
expect(report.result.plate).toBe("AAA-1");

// before/after probes
expect(report.before.cars).toEqual({ count: "0" });
expect(report.after.cars).toEqual({ count: "1" });

// side effects + captured queries
expect(report.sideEffects["cascade_demo.car"]?.inserted).toBe(1);
expect(report.queries.some((q) => q.kind === "plan")).toBe(true);
```

---

## Session GUCs

Supported capture controls (set via `options.gucs`):

- `enabled`
- `allowedDatabases`
- `rowIncludeSchemas`
- `rowExcludeSchemas`
- `logUtility`

These are applied with `SET LOCAL`, so they are transaction-scoped in wrapper APIs.

---

## Extension objects (high level)

- `sidefx_log` - row events from attached tables
- `sidefx_query_plan` - captured plans and index usage
- `sidefx_utility_log` - utility/DDL events
- helper functions:
  - `sidefx_attach(regclass)`
  - `sidefx_summary(txid)`
  - `sidefx_utility_summary(txid)`
  - `sidefx_assert_*` / `sidefx_explain_*`

---

## Project layout

- `extension/` - PostgreSQL extension SQL + C hook implementation
- `src/` - TypeScript SDK/assertion layer
- `src/sdk/` - SDK entrypoints for explicit SDK imports
- `src/__tests__/integration.test.ts` - end-to-end integration tests
- `examples/car-service/src/` - example business API/service layer
- `examples/car-service/test/` - example integration test using SideFx wrappers
- `docs/unintended-side-effects.md` - behavior notes and capture model
- `USAGE.md` - focused TypeScript usage guide
- `TEST_REPORT.md` - concise per-test explanation

---

## Status

Current integration suite covers:
- row/plan capture
- 1:M and M:M cascades
- utility logging
- update tracking
- allowed database gating
- structured summary API

---

## License

No license file is currently included in this repository.
