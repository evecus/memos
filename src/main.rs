mod api;
mod auth;
mod config;
mod error;
mod models;
mod static_files;
mod store;

use std::sync::Arc;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let cfg = config::parse();
    let store = Arc::new(store::Store::open(&cfg.data_dir)?);
    let needs_setup = store.needs_setup()?;

    let app = api::router(api::AppState { store });
    let listener = tokio::net::TcpListener::bind(cfg.addr.as_str()).await?;

    println!("simple-memos (rust) listening on http://{}", cfg.addr);
    println!("data directory: {}", cfg.data_dir.display());
    if needs_setup {
        println!("first run: open the URL and complete setup");
    }

    axum::serve(listener, app).await?;
    Ok(())
}
