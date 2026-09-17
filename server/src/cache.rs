use std::{
    collections::HashMap,
    future::Future,
    sync::Arc,
    time::{Duration, Instant},
};

use serde_json::Value;
use tokio::sync::{Mutex, RwLock};

/// Tiny TTL cache with single-flight semantics: concurrent misses for the same key
/// run the fetch once and share the result. Values are the normalized JSON payloads
/// the API already returns, so hits skip the whole MCP round trip.
#[derive(Default)]
pub struct Cache {
    entries: RwLock<HashMap<String, (Instant, Value)>>,
    gates: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl Cache {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn get_or_fetch<F, Fut, E>(
        &self,
        key: &str,
        ttl: Duration,
        fetch: F,
    ) -> Result<Value, E>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Value, E>>,
    {
        if let Some(value) = self.lookup(key, ttl).await {
            return Ok(value);
        }
        let gate = {
            let mut gates = self.gates.lock().await;
            gates
                .entry(key.to_string())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        let _guard = gate.lock().await;
        // Another task may have filled the cache while we waited for the gate.
        if let Some(value) = self.lookup(key, ttl).await {
            return Ok(value);
        }
        let value = fetch().await?;
        let mut entries = self.entries.write().await;
        entries.insert(key.to_string(), (Instant::now(), value.clone()));
        // Drop entries that are far past any TTL so the map cannot grow without bound.
        entries.retain(|_, (inserted, _)| inserted.elapsed() < Duration::from_secs(3600));
        Ok(value)
    }

    async fn lookup(&self, key: &str, ttl: Duration) -> Option<Value> {
        let entries = self.entries.read().await;
        let (inserted, value) = entries.get(key)?;
        if inserted.elapsed() < ttl {
            Some(value.clone())
        } else {
            None
        }
    }

    pub async fn len(&self) -> usize {
        self.entries.read().await.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn caches_within_ttl() {
        let cache = Cache::new();
        let calls = AtomicUsize::new(0);
        for _ in 0..3 {
            let value = cache
                .get_or_fetch("k", Duration::from_secs(60), || async {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok::<_, ()>(serde_json::json!({ "n": 1 }))
                })
                .await
                .unwrap();
            assert_eq!(value["n"], 1);
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn refetches_after_ttl() {
        let cache = Cache::new();
        let calls = AtomicUsize::new(0);
        cache
            .get_or_fetch("k", Duration::from_millis(1), || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok::<_, ()>(serde_json::json!({ "ok": true }))
            })
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(5)).await;
        cache
            .get_or_fetch("k", Duration::from_millis(1), || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok::<_, ()>(serde_json::json!({ "ok": true }))
            })
            .await
            .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn single_flight_for_concurrent_misses() {
        let cache = Arc::new(Cache::new());
        let calls = Arc::new(AtomicUsize::new(0));
        let mut tasks = Vec::new();
        for _ in 0..8 {
            let cache = cache.clone();
            let calls = calls.clone();
            tasks.push(tokio::spawn(async move {
                cache
                    .get_or_fetch("k", Duration::from_secs(60), || async {
                        tokio::time::sleep(Duration::from_millis(30)).await;
                        calls.fetch_add(1, Ordering::SeqCst);
                        Ok::<_, ()>(serde_json::json!({ "ok": true }))
                    })
                    .await
                    .unwrap()
            }));
        }
        for task in tasks {
            task.await.unwrap();
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
