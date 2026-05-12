import path from "node:path";
import pg from "pg";
import { GenericContainer } from "testcontainers";
import type { StartedTestContainer } from "testcontainers";
import { CarService } from "../src/car-service";
import { PgSideFx } from "../../../sdk/typescript";
import { describe, it, beforeAll, afterAll, expect } from "vitest";

describe("car-service integration example", () => {
  let container: StartedTestContainer;
  let pool: pg.Pool;

  beforeAll(async () => {
    const repoRoot = path.join(__dirname, "..", "..", "..");
    const generic = await GenericContainer.fromDockerfile(
      repoRoot,
      "docker/Dockerfile",
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

  it("createCar flow with sidefx assertions", async () => {
    const sidefx = PgSideFx.init(pool, {
      gucs: { allowedDatabases: "test", logUtility: true },
    });

    await sidefx.ensureExtension();
    const setupClient = await pool.connect();
    try {
      const setupService = new CarService(setupClient);
      await setupService.ensureDemoSchema();
    } finally {
      setupClient.release();
    }

    await sidefx.attachTables([
      "demo.person",
      "demo.car",
      "demo.model",
      "demo.car_model",
    ]);

    const report = await sidefx.summarize(
      async (client) => {
        const carService = new CarService(client);
        const person = await carService.createPerson("Ada");
        const car = await carService.createCar({
          personId: person.id,
          plate: "AAA-1",
        });
        const model = await carService.createModel("Coupe");
        await carService.assignModel({ carId: car.id, modelId: model.id });
        await carService.removeModel({ carId: car.id, modelId: model.id });
        await carService.assignModel({ carId: car.id, modelId: model.id });
        await carService.deletePerson(person.id); // cascades car + car_model
        return { person, car, model, deletedPersonId: person.id };
      },
      {
        snapshots: {
          cars: "SELECT count(*)::bigint AS count FROM demo.car",
        },
      },
    );

    expect(report.result.car.plate).toBe("AAA-1");
    expect(report.sideEffects["demo.person"]?.inserted).toBe(1);
    expect(report.sideEffects["demo.person"]?.deleted).toBe(1);
    expect(report.sideEffects["demo.car"]?.inserted).toBe(1);
    expect(report.sideEffects["demo.car"]?.deleted).toBe(1);
    expect(report.sideEffects["demo.car_model"]?.inserted).toBe(2);
    expect(report.sideEffects["demo.car_model"]?.deleted).toBe(2);
    expect(report.after.cars).toEqual({ count: "0" });
    expect(
      report.rowEvents.some(
        (e) => e.table === "demo.car_model" && e.operation === "DELETE",
      ),
    ).toBe(true);
    expect(report.queries.some((q) => q.isCascadeRelated)).toBe(true);

  });
});

