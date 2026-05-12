//! Mirrors `examples/car-service/src/car-service.ts` for integration tests.

use pg_sidefx::PgSidefxError;
use tokio_postgres::Client;

pub struct Person {
    pub id: i64,
    #[allow(dead_code)]
    pub name: String,
}

pub struct Car {
    pub id: i64,
    #[allow(dead_code)]
    pub person_id: i64,
    pub plate: String,
}

pub struct Model {
    pub id: i64,
    #[allow(dead_code)]
    pub name: String,
}

pub struct CarService<'a> {
    client: &'a Client,
}

impl<'a> CarService<'a> {
    pub fn new(client: &'a Client) -> Self {
        Self { client }
    }

    pub async fn ensure_demo_schema(&self) -> Result<(), PgSidefxError> {
        self.client
            .batch_execute(
                r"
            DROP SCHEMA IF EXISTS demo CASCADE;
            CREATE SCHEMA demo;
            CREATE TABLE demo.person (
              id bigserial PRIMARY KEY,
              name text NOT NULL
            );
            CREATE TABLE demo.car (
              id bigserial PRIMARY KEY,
              person_id bigint NOT NULL
                REFERENCES demo.person (id) ON DELETE CASCADE,
              plate text NOT NULL
            );
            CREATE TABLE demo.model (
              id bigserial PRIMARY KEY,
              name text NOT NULL
            );
            CREATE TABLE demo.car_model (
              car_id bigint NOT NULL
                REFERENCES demo.car (id) ON DELETE CASCADE,
              model_id bigint NOT NULL
                REFERENCES demo.model (id) ON DELETE CASCADE,
              PRIMARY KEY (car_id, model_id)
            );
            CREATE INDEX car_person_id_idx ON demo.car (person_id);
            CREATE INDEX car_model_car_id_idx ON demo.car_model (car_id);
            CREATE INDEX car_model_model_id_idx ON demo.car_model (model_id);
            ",
            )
            .await?;
        Ok(())
    }

    pub async fn create_person(&self, name: &str) -> Result<Person, PgSidefxError> {
        let row = self
            .client
            .query_one(
                "INSERT INTO demo.person (name) VALUES ($1) RETURNING id, name",
                &[&name],
            )
            .await?;
        Ok(Person {
            id: row.get(0),
            name: row.get(1),
        })
    }

    pub async fn create_car(&self, person_id: i64, plate: &str) -> Result<Car, PgSidefxError> {
        let row = self
            .client
            .query_one(
                "INSERT INTO demo.car (person_id, plate) VALUES ($1, $2) RETURNING id, plate",
                &[&person_id, &plate],
            )
            .await?;
        Ok(Car {
            id: row.get(0),
            person_id,
            plate: row.get(1),
        })
    }

    pub async fn create_model(&self, name: &str) -> Result<Model, PgSidefxError> {
        let row = self
            .client
            .query_one(
                "INSERT INTO demo.model (name) VALUES ($1) RETURNING id, name",
                &[&name],
            )
            .await?;
        Ok(Model {
            id: row.get(0),
            name: row.get(1),
        })
    }

    pub async fn assign_model(&self, car_id: i64, model_id: i64) -> Result<(), PgSidefxError> {
        self.client
            .execute(
                "INSERT INTO demo.car_model (car_id, model_id) VALUES ($1, $2)",
                &[&car_id, &model_id],
            )
            .await?;
        Ok(())
    }

    pub async fn remove_model(&self, car_id: i64, model_id: i64) -> Result<(), PgSidefxError> {
        self.client
            .execute(
                "DELETE FROM demo.car_model WHERE car_id = $1 AND model_id = $2",
                &[&car_id, &model_id],
            )
            .await?;
        Ok(())
    }

    pub async fn delete_person(&self, person_id: i64) -> Result<(), PgSidefxError> {
        self.client
            .execute("DELETE FROM demo.person WHERE id = $1", &[&person_id])
            .await?;
        Ok(())
    }
}
