use thiserror::Error;

#[derive(Debug, Error)]
pub enum PgSidefxError {
    #[error(transparent)]
    Postgres(#[from] tokio_postgres::Error),
    #[error(transparent)]
    Pool(#[from] deadpool_postgres::PoolError),
    #[error(transparent)]
    Build(#[from] deadpool_postgres::BuildError),
    #[error("database assertion failed: {0}")]
    AssertionFailed(String),
    #[error("explainTotalCost: missing or invalid Total Cost on plan root")]
    InvalidExplainCost,
}
