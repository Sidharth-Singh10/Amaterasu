//! Live checks against the INDmoney OAuth endpoints. Ignored by default:
//! `cargo test --test live_oauth -- --ignored`

use amaterasu_server::indmoney::oauth;

#[tokio::test]
#[ignore = "hits the live INDmoney OAuth endpoints"]
async fn discovery_and_dynamic_registration_work() {
    let http = reqwest::Client::new();
    let (resource, metadata) = oauth::discover(&http, "https://mcp.indmoney.com/mcp")
        .await
        .expect("resource + authorization-server discovery");

    assert_eq!(resource.resource, "https://mcp.indmoney.com/mcp");
    assert!(
        metadata.authorization_endpoint.ends_with("/authorize"),
        "unexpected authorize endpoint: {}",
        metadata.authorization_endpoint
    );
    assert!(
        metadata.token_endpoint.ends_with("/token"),
        "unexpected token endpoint: {}",
        metadata.token_endpoint
    );
    assert!(metadata.registration_endpoint.is_some(), "DCR is required for this client");

    let client = oauth::register_client(
        &http,
        &metadata,
        "http://127.0.0.1:8787/api/indmoney/oauth/callback",
        "Amaterasu (test registration)",
        "market:read portfolio:read",
    )
    .await
    .expect("dynamic client registration");

    assert!(!client.client_id.is_empty());
    assert!(client.client_secret.is_some(), "server advertises client_secret_post");
}
