use std::future::Future;

use deadpool_postgres::{Client as PooledClient, Pool};

use crate::capture::merged_expect_options;
use crate::error::PgSidefxError;
use crate::expect::{expect_db_side_effects, SideEffectAssertion, SidefxBoxFuture};
use crate::summarize::summarize_db_side_effects;
use crate::types::{
    ExpectDbSideEffectsOptions, SidefxChangeSummary, SummarizeDbSideEffectsOptions,
};

/// Pool wrapper mirroring TypeScript `PgSideFx.init(pool, options?)`.
pub struct PgSideFx {
    pool: Pool,
    base_options: Option<ExpectDbSideEffectsOptions>,
}

impl PgSideFx {
    pub fn new(pool: Pool, base_options: Option<ExpectDbSideEffectsOptions>) -> Self {
        Self {
            pool,
            base_options,
        }
    }

    async fn with_client<F, Fut, T>(&self, f: F) -> Result<T, PgSidefxError>
    where
        F: FnOnce(PooledClient) -> Fut,
        Fut: Future<Output = Result<T, PgSidefxError>>,
    {
        let client = self.pool.get().await?;
        f(client).await
    }

    pub async fn ensure_extension(&self) -> Result<(), PgSidefxError> {
        self.with_client(|client| async move {
            client
                .execute("CREATE EXTENSION IF NOT EXISTS pg_sidefx", &[])
                .await?;
            Ok(())
        })
        .await
    }

    pub async fn attach_table(&self, table_fqn: &str) -> Result<(), PgSidefxError> {
        let t = table_fqn.to_string();
        self.with_client(move |client| async move {
            client
                .execute(
                    "SELECT sidefx_attach(($1)::text::regclass)",
                    &[&t],
                )
                .await?;
            Ok(())
        })
        .await
    }

    pub async fn attach_tables(&self, table_fqns: &[&str]) -> Result<(), PgSidefxError> {
        let owned: Vec<String> = table_fqns.iter().map(|s| (*s).to_string()).collect();
        self.with_client(move |client| async move {
            for t in &owned {
                client
                    .execute(
                        "SELECT sidefx_attach(($1)::text::regclass)",
                        &[t],
                    )
                    .await?;
            }
            Ok(())
        })
        .await
    }

    pub async fn expect(
        &self,
        action: impl for<'c> FnOnce(&'c tokio_postgres::Client) -> SidefxBoxFuture<'c, ()>,
        options: Option<ExpectDbSideEffectsOptions>,
    ) -> Result<SideEffectAssertion, PgSidefxError> {
        self.with_client(|client| async move {
            let merged = merged_expect_options(self.base_options.as_ref(), options.as_ref());
            expect_db_side_effects(&*client, |c| action(c), merged).await
        })
        .await
    }

    pub async fn summarize<T: Send>(
        &self,
        action: impl for<'c> FnOnce(&'c tokio_postgres::Client) -> SidefxBoxFuture<'c, T>,
        options: Option<SummarizeDbSideEffectsOptions>,
    ) -> Result<SidefxChangeSummary<T>, PgSidefxError> {
        self.with_client(|client| async move {
            let call = options.unwrap_or_default();
            let merged_gucs = merged_expect_options(
                self.base_options.as_ref(),
                Some(&ExpectDbSideEffectsOptions {
                    gucs: call.gucs.clone(),
                }),
            );
            let final_opts = SummarizeDbSideEffectsOptions {
                snapshots: call.snapshots,
                gucs: merged_gucs.and_then(|m| m.gucs).or(call.gucs),
            };
            summarize_db_side_effects(&*client, |c| action(c), Some(final_opts)).await
        })
        .await
    }
}
