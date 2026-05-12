//! End-to-end tests: same scenarios as `examples/car-service/test/integration.test.ts`.

mod car_service;

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;
use car_service::CarService;
use pg_sidefx::deadpool_postgres::{Manager, Pool, Runtime};
use pg_sidefx::{
    ExpectDbSideEffectsOptions, PgSideFx, PgSidefxGucs, SummarizeDbSideEffectsOptions,
};
use testcontainers::core::{IntoContainerPort, WaitFor};
use testcontainers::runners::AsyncRunner;
use testcontainers::{GenericImage, ImageExt};
use tokio_postgres::NoTls;

const IMAGE_NAME: &str = "pg-sidefx-rust-it";
const IMAGE_TAG: &str = "latest";

#[derive(Debug)]
struct FlowResult {
    car_plate: String,
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("canonicalize repo root")
}

fn docker_build_extension_image(repo: &PathBuf) {
    let status = Command::new("docker")
        .args([
            "build",
            "-t",
            &format!("{IMAGE_NAME}:{IMAGE_TAG}"),
            "-f",
            "docker/Dockerfile",
            ".",
        ])
        .current_dir(repo)
        .status()
        .expect("spawn docker build");
    assert!(status.success(), "docker build failed: {status:?}");
}

fn snapshot_count_as_i64(row: Option<&std::collections::HashMap<String, serde_json::Value>>) -> Option<i64> {
    row?.get("count")?.as_i64()
}

/// Same flow and assertions as `examples/car-service/test/integration.test.ts` (`createCar flow with sidefx assertions`).
#[tokio::test]
async fn create_car_flow_with_sidefx_assertions() {
    let root = repo_root();
    docker_build_extension_image(&root);

    let image = GenericImage::new(IMAGE_NAME, IMAGE_TAG)
        .with_exposed_port(5432.tcp())
        .with_wait_for(WaitFor::message_on_stderr(
            "database system is ready to accept connections",
        ))
        .with_env_var("POSTGRES_USER", "test")
        .with_env_var("POSTGRES_PASSWORD", "test")
        .with_env_var("POSTGRES_DB", "test");

    let container = image
        .start()
        .await
        .expect("start postgres container");

    let port = container
        .get_host_port_ipv4(5432.tcp())
        .await
        .expect("host port");

    let pg = tokio_postgres::Config::new()
        .host("127.0.0.1")
        .port(port)
        .user("test")
        .password("test")
        .dbname("test")
        .application_name("pg_sidefx_car_service_rust_test")
        .to_owned();

    let mgr = Manager::new(pg, NoTls);
    let pool = Pool::builder(mgr)
        .max_size(8)
        .runtime(Runtime::Tokio1)
        .build()
        .expect("pool");

    let sidefx = PgSideFx::new(
        pool.clone(),
        Some(ExpectDbSideEffectsOptions {
            gucs: Some(PgSidefxGucs {
                allowed_databases: Some("test".into()),
                log_utility: Some(true),
                ..Default::default()
            }),
        }),
    );

    sidefx.ensure_extension().await.expect("ensure extension");

    {
        let client = pool.get().await.expect("pool client");
        let setup = CarService::new(&*client);
        setup.ensure_demo_schema().await.expect("demo schema");
    }

    sidefx
        .attach_tables(&[
            "demo.person",
            "demo.car",
            "demo.model",
            "demo.car_model",
        ])
        .await
        .expect("attach");

    let mut snapshots = HashMap::new();
    snapshots.insert(
        "cars".into(),
        "SELECT count(*)::bigint AS count FROM demo.car".into(),
    );

    let report = sidefx
        .summarize(
            |client| {
                Box::pin(async move {
                    let car_service = CarService::new(client);
                    let person = car_service.create_person("Ada").await?;
                    let car = car_service
                        .create_car(person.id, "AAA-1")
                        .await?;
                    let model = car_service.create_model("Coupe").await?;
                    car_service.assign_model(car.id, model.id).await?;
                    car_service.remove_model(car.id, model.id).await?;
                    car_service.assign_model(car.id, model.id).await?;
                    car_service.delete_person(person.id).await?;
                    Ok(FlowResult {
                        car_plate: car.plate,
                    })
                })
            },
            Some(SummarizeDbSideEffectsOptions {
                snapshots: Some(snapshots),
                ..Default::default()
            }),
        )
        .await
        .expect("summarize");

    assert_eq!(report.result.car_plate, "AAA-1");
    assert_eq!(
        report.side_effects.get("demo.person").and_then(|s| s.inserted),
        Some(1)
    );
    assert_eq!(
        report.side_effects.get("demo.person").and_then(|s| s.deleted),
        Some(1)
    );
    assert_eq!(
        report.side_effects.get("demo.car").and_then(|s| s.inserted),
        Some(1)
    );
    assert_eq!(
        report.side_effects.get("demo.car").and_then(|s| s.deleted),
        Some(1)
    );
    assert_eq!(
        report
            .side_effects
            .get("demo.car_model")
            .and_then(|s| s.inserted),
        Some(2)
    );
    assert_eq!(
        report
            .side_effects
            .get("demo.car_model")
            .and_then(|s| s.deleted),
        Some(2)
    );

    let after_cars = report.after.get("cars").and_then(|o| o.as_ref());
    assert_eq!(
        snapshot_count_as_i64(after_cars),
        Some(0),
        "after.cars count: {:?}",
        after_cars
    );

    assert!(
        report.row_events.iter().any(|e| {
            e.table == "demo.car_model" && e.operation == "DELETE"
        }),
        "expected a DELETE row event on demo.car_model"
    );

    assert!(
        report
            .queries
            .iter()
            .any(|q| q.is_cascade_related.unwrap_or(false)),
        "expected at least one cascade-related captured query"
    );

    let _ = container;
}
