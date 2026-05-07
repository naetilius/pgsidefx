import type { PoolClient } from "pg";

export type Person = { id: string; name: string };
export type Car = { id: string; personId: string; plate: string };
export type Model = { id: string; name: string };

export class CarService {
  constructor(private readonly client: PoolClient) {}

  async ensureDemoSchema(): Promise<void> {
    await this.client.query("DROP SCHEMA IF EXISTS demo CASCADE");
    await this.client.query("CREATE SCHEMA demo");
    await this.client.query(`
      CREATE TABLE demo.person (
        id bigserial PRIMARY KEY,
        name text NOT NULL
      )
    `);
    await this.client.query(`
      CREATE TABLE demo.car (
        id bigserial PRIMARY KEY,
        person_id bigint NOT NULL
          REFERENCES demo.person (id) ON DELETE CASCADE,
        plate text NOT NULL
      )
    `);
    await this.client.query(`
      CREATE TABLE demo.model (
        id bigserial PRIMARY KEY,
        name text NOT NULL
      )
    `);
    await this.client.query(`
      CREATE TABLE demo.car_model (
        car_id bigint NOT NULL
          REFERENCES demo.car (id) ON DELETE CASCADE,
        model_id bigint NOT NULL
          REFERENCES demo.model (id) ON DELETE CASCADE,
        PRIMARY KEY (car_id, model_id)
      )
    `);

    // explicit indexes for relationship lookups in tests
    await this.client.query("CREATE INDEX car_person_id_idx ON demo.car (person_id)");
    await this.client.query(
      "CREATE INDEX car_model_car_id_idx ON demo.car_model (car_id)",
    );
    await this.client.query(
      "CREATE INDEX car_model_model_id_idx ON demo.car_model (model_id)",
    );
  }

  async createPerson(name: string): Promise<Person> {
    const { rows } = await this.client.query<{ id: string; name: string }>(
      "INSERT INTO demo.person (name) VALUES ($1) RETURNING id, name",
      [name],
    );
    return rows[0];
  }

  async createCar(input: { personId: string; plate: string }): Promise<Car> {
    const { rows } = await this.client.query<{ id: string; plate: string }>(
      `INSERT INTO demo.car (person_id, plate)
       VALUES ($1, $2)
       RETURNING id, plate`,
      [input.personId, input.plate],
    );
    return { id: rows[0].id, personId: input.personId, plate: rows[0].plate };
  }

  async createModel(name: string): Promise<Model> {
    const { rows } = await this.client.query<{ id: string; name: string }>(
      "INSERT INTO demo.model (name) VALUES ($1) RETURNING id, name",
      [name],
    );
    return rows[0];
  }

  async assignModel(input: { carId: string; modelId: string }): Promise<void> {
    await this.client.query(
      "INSERT INTO demo.car_model (car_id, model_id) VALUES ($1, $2)",
      [input.carId, input.modelId],
    );
  }

  async removeModel(input: { carId: string; modelId: string }): Promise<void> {
    await this.client.query(
      "DELETE FROM demo.car_model WHERE car_id = $1 AND model_id = $2",
      [input.carId, input.modelId],
    );
  }

  async deleteCar(carId: string): Promise<void> {
    await this.client.query("DELETE FROM demo.car WHERE id = $1", [carId]);
  }

  async deletePerson(personId: string): Promise<void> {
    await this.client.query("DELETE FROM demo.person WHERE id = $1", [
      personId,
    ]);
  }
}

