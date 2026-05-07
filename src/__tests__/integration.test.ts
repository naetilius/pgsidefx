import path from "node:path";
import { GenericContainer } from "testcontainers";
import type { StartedTestContainer } from "testcontainers";
import pg from "pg";
import {
  assertNumericEq,
  assertRowCount,
  assertSumEq,
  assertTextEq,
  expectDbSideEffects,
  expectIndexUsedFromSet,
  expectExplainNodeTypesAbsent,
  expectExplainUsesIndex,
  expectNoSeqScanOn,
  expectPlanCostAtMost,
  PgSideFx,
  summarizeDbSideEffects,
} from "../index";

class CarService {
  constructor(private readonly client: pg.PoolClient) {}

  async createCar(input: {
    table: "api_summary_orders" | "oop_orders";
    customerId: number;
    total: number;
  }): Promise<{ ok: true; id: string; orderRef: string }> {
    const { rows } = await this.client.query<{ id: string }>(
      `INSERT INTO ${input.table} (customer_id, total) VALUES ($1, $2) RETURNING id`,
      [input.customerId, input.total],
    );
    return { ok: true, id: rows[0].id, orderRef: `order-${input.customerId}` };
  }
}

describe("pg_sidefx (integration)", () => {
  let container: StartedTestContainer;
  let pool: pg.Pool;

  beforeAll(async () => {
    const repoRoot = path.join(__dirname, "..", "..");
    const generic = await GenericContainer.fromDockerfile(
      repoRoot,
      "Dockerfile",
    ).build();

    container = await generic
      .withExposedPorts(5432)
      .withEnvironment({
        POSTGRES_USER: "test",
        POSTGRES_PASSWORD: "test",
        POSTGRES_DB: "test",
      })
      .start();

    pool = new pg.Pool({
      host: container.getHost(),
      port: container.getMappedPort(5432),
      user: "test",
      password: "test",
      database: "test",
    });
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it("tracks row changes and captures plans + index usage", async () => {
    const client = await pool.connect();
    try {
      await client.query("CREATE EXTENSION IF NOT EXISTS pg_sidefx");

      await client.query(`
        CREATE TABLE orders (
          id bigserial PRIMARY KEY,
          customer_id bigint NOT NULL,
          total numeric NOT NULL
        )
      `);

      await client.query(
        "CREATE INDEX orders_customer_id_idx ON orders (customer_id)",
      );

      await client.query("SELECT sidefx_attach('public.orders'::regclass)");

      const assertion = await expectDbSideEffects(
        client,
        async () => {
          await client.query("SET LOCAL enable_seqscan = off");
          await client.query("SELECT sidefx_begin('car-flow')");

          await client.query(
            "INSERT INTO orders (customer_id, total) VALUES ($1, $2)",
            [42, 19.99],
          );

          await assertRowCount(
            client,
            "SELECT * FROM orders WHERE customer_id = 42",
            1,
          );
          await assertSumEq(client, "SELECT * FROM orders", "total", "19.99");

          const lookup = "SELECT * FROM orders WHERE customer_id = 42";
          await expectExplainUsesIndex(
            client,
            lookup,
            "orders_customer_id_idx",
          );
          await expectExplainNodeTypesAbsent(client, lookup, ["Seq Scan"]);
          await expectPlanCostAtMost(client, lookup, 1e12);

          await client.query(
            "SELECT * FROM orders WHERE customer_id = $1",
            [42],
          );
        },
        { gucs: { allowedDatabases: "test" } },
      );

      assertion.toMatch({
        "public.orders": { inserted: 1 },
      });
      assertion.onlyAffectedTables(["public.orders"]);
      assertion.notAffectedTables(["public.missing_table"]);
      assertion.OnlyAffectedTables(["public.orders"]);
      assertion.NotAffectedTables(["public.missing_table"]);

      assertion.usedIndex("orders_customer_id_idx");
      assertion.noSeqScan("orders");
    } finally {
      client.release();
    }
  }, 120_000);

  it("1-M and M-M schema: cascades, FK indexes, and indexed lookups", async () => {
    const client = await pool.connect();
    try {
      await client.query("CREATE EXTENSION IF NOT EXISTS pg_sidefx");

      await client.query("DROP SCHEMA IF EXISTS cascade_demo CASCADE");
      await client.query("CREATE SCHEMA cascade_demo");

      await client.query(`
        CREATE TABLE cascade_demo.person (
          id bigserial PRIMARY KEY,
          name text NOT NULL
        )
      `);

      await client.query(`
        CREATE TABLE cascade_demo.car (
          id bigserial PRIMARY KEY,
          person_id bigint NOT NULL
            REFERENCES cascade_demo.person (id) ON DELETE CASCADE,
          plate text NOT NULL
        )
      `);

      await client.query(`
        CREATE TABLE cascade_demo.model (
          id bigserial PRIMARY KEY,
          name text NOT NULL
        )
      `);

      await client.query(`
        CREATE TABLE cascade_demo.car_model (
          car_id bigint NOT NULL
            REFERENCES cascade_demo.car (id) ON DELETE CASCADE,
          model_id bigint NOT NULL
            REFERENCES cascade_demo.model (id) ON DELETE CASCADE,
          PRIMARY KEY (car_id, model_id)
        )
      `);

      await client.query(
        "CREATE INDEX car_person_id_idx ON cascade_demo.car (person_id)",
      );
      await client.query(
        "CREATE INDEX car_model_car_id_idx ON cascade_demo.car_model (car_id)",
      );
      await client.query(
        "CREATE INDEX car_model_model_id_idx ON cascade_demo.car_model (model_id)",
      );

      for (const tbl of ["person", "car", "model", "car_model"] as const) {
        await client.query(
          `SELECT sidefx_attach(format('%I.%I', 'cascade_demo', $1::text)::regclass)`,
          [tbl],
        );
      }

      const assertion = await expectDbSideEffects(
        client,
        async () => {
          await client.query("SET LOCAL enable_seqscan = off");

          const {
            rows: [person],
          } = await client.query<{ id: string }>(
            `INSERT INTO cascade_demo.person (name) VALUES ('Ada') RETURNING id`,
          );

          const {
            rows: [m1],
          } = await client.query<{ id: string }>(
            `INSERT INTO cascade_demo.model (name) VALUES ('Coupe') RETURNING id`,
          );
          const {
            rows: [m2],
          } = await client.query<{ id: string }>(
            `INSERT INTO cascade_demo.model (name) VALUES ('SUV') RETURNING id`,
          );

          const {
            rows: [car1],
          } = await client.query<{ id: string }>(
            `INSERT INTO cascade_demo.car (person_id, plate)
             VALUES ($1, 'AAA-1') RETURNING id`,
            [person.id],
          );
          const {
            rows: [car2],
          } = await client.query<{ id: string }>(
            `INSERT INTO cascade_demo.car (person_id, plate)
             VALUES ($1, 'BBB-2') RETURNING id`,
            [person.id],
          );

          await client.query(
            `INSERT INTO cascade_demo.car_model (car_id, model_id) VALUES
             ($1::bigint, $2::bigint),
             ($1::bigint, $3::bigint),
             ($4::bigint, $2::bigint),
             ($4::bigint, $3::bigint)`,
            [car1.id, m1.id, m2.id, car2.id],
          );

          await assertRowCount(
            client,
            `SELECT * FROM cascade_demo.car WHERE person_id = ${person.id}`,
            2,
          );
          await assertRowCount(
            client,
            `SELECT * FROM cascade_demo.car_model WHERE model_id = ${m1.id}`,
            2,
          );

          const carsByPerson = `SELECT * FROM cascade_demo.car WHERE person_id = ${person.id}`;
          await expectExplainUsesIndex(client, carsByPerson, "car_person_id_idx");
          await expectExplainNodeTypesAbsent(client, carsByPerson, ["Seq Scan"]);
          await expectNoSeqScanOn(client, carsByPerson, "car");

          const carsForModel = `SELECT c.* FROM cascade_demo.car c
            JOIN cascade_demo.car_model cm ON cm.car_id = c.id
            WHERE cm.model_id = ${m1.id}`;
          await expectExplainUsesIndex(
            client,
            carsForModel,
            "car_model_model_id_idx",
          );
          await expectExplainNodeTypesAbsent(client, carsForModel, ["Seq Scan"]);
          await expectIndexUsedFromSet(client, carsForModel, [
            "car_model_model_id_idx",
            "car_model_car_id_idx",
          ]);

          await client.query(
            "SELECT * FROM cascade_demo.car WHERE person_id = $1",
            [person.id],
          );
          await client.query(
            `SELECT c.* FROM cascade_demo.car c
             JOIN cascade_demo.car_model cm ON cm.car_id = c.id
             WHERE cm.model_id = $1`,
            [m2.id],
          );

          await client.query(
            "DELETE FROM cascade_demo.person WHERE id = $1",
            [person.id],
          );

          await assertRowCount(
            client,
            "SELECT * FROM cascade_demo.car",
            0,
          );
          await assertRowCount(
            client,
            "SELECT * FROM cascade_demo.car_model",
            0,
          );
          await assertRowCount(
            client,
            "SELECT * FROM cascade_demo.model",
            2,
          );

          await client.query(
            "COMMENT ON TABLE cascade_demo.car IS 'correlated car flow'",
          );
          await client.query("SELECT sidefx_end()");

          await assertNumericEq(
            client,
            `SELECT count(*)::numeric FROM sidefx_export_queue WHERE txid = txid_current()::bigint`,
            1,
          );
          await assertNumericEq(
            client,
            `SELECT count(*)::numeric FROM sidefx_recent_changes
             WHERE txid = txid_current()::bigint
               AND table_fqn = 'cascade_demo.car_model'
               AND operation = 'DELETE'`,
            4,
          );
          const { rows: timelineRows } = await client.query<{ c: string }>(
            `SELECT count(*)::bigint::text AS c
             FROM sidefx_tx_timeline(txid_current()::bigint)
             WHERE event_kind IN ('row', 'utility', 'begin', 'end')`,
          );
          expect(Number(timelineRows[0].c)).toBeGreaterThan(0);
          await assertNumericEq(
            client,
            `SELECT count(*)::numeric FROM sidefx_top_tables
             WHERE table_fqn = 'cascade_demo.car_model' AND deleted = 4`,
            1,
          );
        },
        { gucs: { allowedDatabases: "test", logUtility: true } },
      );

      assertion.toMatch({
        "cascade_demo.person": { inserted: 1, deleted: 1 },
        "cascade_demo.car": { inserted: 2, deleted: 2 },
        "cascade_demo.model": { inserted: 2 },
        "cascade_demo.car_model": { inserted: 4, deleted: 4 },
      });

      assertion.usedIndex("car_person_id_idx");
      assertion.usedIndex("car_model_model_id_idx");
      assertion.utilitiesToMatch({ COMMENT: 1 });
      expect(
        assertion.utilityRows.some(
          (r) =>
            r.stmt_tag === "COMMENT" &&
            r.object_type === "TABLE" &&
            r.object_name === "car",
        ),
      ).toBe(true);
    } finally {
      client.release();
    }
  }, 120_000);

  it("M-M: deleting model removes only junction rows; person and cars stay", async () => {
    const client = await pool.connect();
    try {
      await client.query("CREATE EXTENSION IF NOT EXISTS pg_sidefx");

      await client.query("DROP SCHEMA IF EXISTS junction_model_del CASCADE");
      await client.query("CREATE SCHEMA junction_model_del");

      await client.query(`
        CREATE TABLE junction_model_del.person (
          id bigserial PRIMARY KEY,
          name text NOT NULL
        )
      `);
      await client.query(`
        CREATE TABLE junction_model_del.car (
          id bigserial PRIMARY KEY,
          person_id bigint NOT NULL
            REFERENCES junction_model_del.person (id) ON DELETE CASCADE,
          plate text NOT NULL
        )
      `);
      await client.query(`
        CREATE TABLE junction_model_del.model (
          id bigserial PRIMARY KEY,
          name text NOT NULL
        )
      `);
      await client.query(`
        CREATE TABLE junction_model_del.car_model (
          car_id bigint NOT NULL
            REFERENCES junction_model_del.car (id) ON DELETE CASCADE,
          model_id bigint NOT NULL
            REFERENCES junction_model_del.model (id) ON DELETE CASCADE,
          PRIMARY KEY (car_id, model_id)
        )
      `);

      for (const tbl of ["person", "car", "model", "car_model"] as const) {
        await client.query(
          `SELECT sidefx_attach(format('%I.%I', 'junction_model_del', $1::text)::regclass)`,
          [tbl],
        );
      }

      const assertion = await expectDbSideEffects(
        client,
        async () => {
          const {
            rows: [person],
          } = await client.query<{ id: string }>(
            `INSERT INTO junction_model_del.person (name) VALUES ('Lee') RETURNING id`,
          );
          const {
            rows: [car],
          } = await client.query<{ id: string }>(
            `INSERT INTO junction_model_del.car (person_id, plate)
             VALUES ($1, 'ZZ-99') RETURNING id`,
            [person.id],
          );
          const {
            rows: [mSport],
          } = await client.query<{ id: string }>(
            `INSERT INTO junction_model_del.model (name) VALUES ('Sport') RETURNING id`,
          );
          const {
            rows: [mEco],
          } = await client.query<{ id: string }>(
            `INSERT INTO junction_model_del.model (name) VALUES ('Eco') RETURNING id`,
          );

          await client.query(
            `INSERT INTO junction_model_del.car_model (car_id, model_id) VALUES
             ($1::bigint, $2::bigint),
             ($1::bigint, $3::bigint)`,
            [car.id, mSport.id, mEco.id],
          );

          await client.query(
            "DELETE FROM junction_model_del.model WHERE id = $1",
            [mSport.id],
          );

          await assertRowCount(
            client,
            "SELECT * FROM junction_model_del.person",
            1,
          );
          await assertRowCount(
            client,
            "SELECT * FROM junction_model_del.car",
            1,
          );
          await assertRowCount(
            client,
            "SELECT * FROM junction_model_del.model",
            1,
          );
          await assertRowCount(
            client,
            `SELECT * FROM junction_model_del.car_model WHERE car_id = ${car.id}`,
            1,
          );
        },
        { gucs: { allowedDatabases: "test" } },
      );

      assertion.toMatch({
        "junction_model_del.person": { inserted: 1 },
        "junction_model_del.car": { inserted: 1 },
        "junction_model_del.model": { inserted: 2, deleted: 1 },
        "junction_model_del.car_model": { inserted: 2, deleted: 1 },
      });
    } finally {
      client.release();
    }
  }, 120_000);

  it("UPDATE on attached tables appears in sidefx_summary", async () => {
    const client = await pool.connect();
    try {
      await client.query("CREATE EXTENSION IF NOT EXISTS pg_sidefx");

      await client.query("DROP SCHEMA IF EXISTS sidefx_update_demo CASCADE");
      await client.query("CREATE SCHEMA sidefx_update_demo");

      await client.query(`
        CREATE TABLE sidefx_update_demo.person (
          id bigserial PRIMARY KEY,
          name text NOT NULL
        )
      `);
      await client.query(`
        CREATE TABLE sidefx_update_demo.car (
          id bigserial PRIMARY KEY,
          person_id bigint NOT NULL
            REFERENCES sidefx_update_demo.person (id) ON DELETE CASCADE,
          plate text NOT NULL
        )
      `);

      await client.query(
        "SELECT sidefx_attach('sidefx_update_demo.person'::regclass)",
      );
      await client.query(
        "SELECT sidefx_attach('sidefx_update_demo.car'::regclass)",
      );

      const assertion = await expectDbSideEffects(
        client,
        async () => {
          const {
            rows: [person],
          } = await client.query<{ id: string }>(
            `INSERT INTO sidefx_update_demo.person (name) VALUES ('Pat') RETURNING id`,
          );
          await client.query(
            `INSERT INTO sidefx_update_demo.car (person_id, plate)
             VALUES ($1, 'OLD-1')`,
            [person.id],
          );

          await client.query(
            `UPDATE sidefx_update_demo.person SET name = 'Patricia' WHERE id = $1`,
            [person.id],
          );
          await client.query(
            `UPDATE sidefx_update_demo.car SET plate = 'NEW-1'
             WHERE person_id = $1`,
            [person.id],
          );

          await assertTextEq(
            client,
            `SELECT name FROM sidefx_update_demo.person WHERE id = ${person.id}`,
            "Patricia",
          );
          await assertRowCount(
            client,
            `SELECT * FROM sidefx_update_demo.car WHERE plate = 'NEW-1'`,
            1,
          );
        },
        { gucs: { allowedDatabases: "test" } },
      );

      assertion.toMatch({
        "sidefx_update_demo.person": { inserted: 1, updated: 1 },
        "sidefx_update_demo.car": { inserted: 1, updated: 1 },
      });
    } finally {
      client.release();
    }
  }, 120_000);

  it("skips plan capture when allowed_databases does not match", async () => {
    const client = await pool.connect();
    try {
      await client.query("CREATE EXTENSION IF NOT EXISTS pg_sidefx");

      const assertion = await expectDbSideEffects(
        client,
        async () => {
          await client.query("SELECT 1");
        },
        { gucs: { allowedDatabases: "wrongdb,also_wrong" } },
      );

      expect(assertion.planRows.length).toBe(0);
    } finally {
      client.release();
    }
  }, 120_000);

  it("logs utility statements when log_utility is on", async () => {
    const client = await pool.connect();
    try {
      await client.query("CREATE EXTENSION IF NOT EXISTS pg_sidefx");

      await client.query(`
        CREATE TABLE util_probe (id int PRIMARY KEY)
      `);

      const assertion = await expectDbSideEffects(client, async () => {
        await client.query("SET LOCAL pg_sidefx.log_utility = on");
        await client.query("COMMENT ON TABLE util_probe IS 'sidefx probe'");
      });

      expect(
        assertion.utilityRows.some((r) => r.stmt_tag === "COMMENT"),
      ).toBe(true);
      expect(
        assertion.utilityRows.some(
          (r) =>
            r.stmt_tag === "COMMENT" &&
            r.object_type === "TABLE" &&
            r.object_name === "util_probe",
        ),
      ).toBe(true);
      assertion.utilitiesToMatch({ COMMENT: 1 });
    } finally {
      client.release();
    }
  }, 120_000);

  it("returns structured before/after summary around an API-like action", async () => {
    const client = await pool.connect();
    try {
      await client.query("CREATE EXTENSION IF NOT EXISTS pg_sidefx");
      await client.query("DROP TABLE IF EXISTS api_summary_orders");
      await client.query(`
        CREATE TABLE api_summary_orders (
          id bigserial PRIMARY KEY,
          customer_id bigint NOT NULL,
          total numeric NOT NULL
        )
      `);
      await client.query(
        "CREATE INDEX api_summary_orders_customer_id_idx ON api_summary_orders (customer_id)",
      );
      await client.query("SELECT sidefx_attach('public.api_summary_orders'::regclass)");

      const report = await summarizeDbSideEffects(
        client,
        async () => {
          const carService = new CarService(client);
          const created = await carService.createCar({
            table: "api_summary_orders",
            customerId: 7,
            total: 55.5,
          });
          await client.query(
            "SELECT * FROM api_summary_orders WHERE customer_id = $1",
            [7],
          );
          return created;
        },
        {
          gucs: { allowedDatabases: "test", logUtility: true },
          snapshots: {
            orderCount:
              "SELECT count(*)::bigint AS count FROM api_summary_orders",
            orderSum:
              "SELECT coalesce(sum(total), 0)::numeric::text AS total FROM api_summary_orders",
          },
        },
      );

      expect(report.result).toEqual({
        ok: true,
        id: expect.any(String),
        orderRef: "order-7",
      });
      expect(report.before.orderCount).toEqual({ count: "0" });
      expect(report.after.orderCount).toEqual({ count: "1" });
      expect(report.before.orderSum).toEqual({ total: "0" });
      expect(report.after.orderSum).toEqual({ total: "55.5" });
      expect(report.tablesChanged).toContain("public.api_summary_orders");
      expect(report.sideEffects["public.api_summary_orders"]?.inserted).toBe(1);
      expect(report.rowEvents.some((e) => e.isCascade)).toBe(false);
      expect(
        report.queries.some(
          (q) => q.kind === "plan" && q.text.includes("api_summary_orders"),
        ),
      ).toBe(true);
      expect(report.planRows.length).toBeGreaterThan(0);
    } finally {
      client.release();
    }
  }, 120_000);

  it("provides pool-based OOP wrapper via PgSideFx.init()", async () => {
    const sidefx = PgSideFx.init(pool, { gucs: { allowedDatabases: "test" } });

    await sidefx.ensureExtension();

    const client = await pool.connect();
    try {
      await client.query("DROP TABLE IF EXISTS oop_orders");
      await client.query(`
        CREATE TABLE oop_orders (
          id bigserial PRIMARY KEY,
          customer_id bigint NOT NULL,
          total numeric NOT NULL
        )
      `);
    } finally {
      client.release();
    }

    await sidefx.attachTable("public.oop_orders");

    const assertion = await sidefx.expect(async (c) => {
      const carService = new CarService(c);
      await carService.createCar({
        table: "oop_orders",
        customerId: 99,
        total: 100.5,
      });
      await c.query("SELECT * FROM oop_orders WHERE customer_id = $1", [99]);
    });

    assertion.toMatch({
      "public.oop_orders": { inserted: 1 },
    });

    const report = await sidefx.summarize(
      async (c) => {
        const carService = new CarService(c);
        return carService.createCar({
          table: "oop_orders",
          customerId: 100,
          total: 12.25,
        });
      },
      {
        snapshots: {
          count: "SELECT count(*)::bigint AS count FROM oop_orders",
        },
      },
    );

    expect(report.result).toEqual({
      ok: true,
      id: expect.any(String),
      orderRef: "order-100",
    });
    expect(
      report.rowEvents.some((e) => e.table === "public.oop_orders" && !e.isCascade),
    ).toBe(true);
    expect(report.tablesChanged).toContain("public.oop_orders");
    expect(report.before.count).toEqual({ count: "0" });
    expect(report.after.count).toEqual({ count: "1" });
  }, 120_000);
});
