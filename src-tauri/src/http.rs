use std::sync::OnceLock;
use std::time::Duration;

use reqwest::Client;

static GLOBAL_CLIENT: OnceLock<Client> = OnceLock::new();

pub fn client() -> &'static Client {
    GLOBAL_CLIENT.get_or_init(|| {
        Client::builder()
            .pool_idle_timeout(Duration::from_secs(90))
            .pool_max_idle_per_host(8)
            .http2_keep_alive_interval(Duration::from_secs(30))
            .http2_keep_alive_timeout(Duration::from_secs(10))
            .user_agent(concat!("OpenSpeech/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("global reqwest client init failed")
    })
}
