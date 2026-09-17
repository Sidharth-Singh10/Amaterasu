use std::collections::BTreeMap;

use chrono::{NaiveDateTime, TimeZone};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error;

/// Timestamp policy (§6.2): every `datetime_ist` string is a IST wall clock and is
/// converted to a Unix epoch. Known quirk, verified live: daily bars arrive as
/// `05:30:00` (UTC midnight rendered in IST) while intraday bars carry real session
/// times (`09:15`…`15:30`). Parsing IST uniformly keeps both unambiguous and
/// date-consistent for daily bars.

#[derive(Debug, Error)]
pub enum NormalizeError {
    #[error("timestamp `{0}` is not a valid IST wall clock")]
    Timestamp(String),
    #[error("payload is missing `{0}`")]
    Shape(&'static str),
    #[error("field `{0}` is not a number")]
    Number(&'static str),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candle {
    pub time: i64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: i64,
}

pub fn parse_ist_epoch(value: &str) -> Result<i64, NormalizeError> {
    let naive = NaiveDateTime::parse_from_str(value.trim(), "%Y-%m-%d %H:%M:%S")
        .map_err(|_| NormalizeError::Timestamp(value.to_string()))?;
    let zoned = chrono_tz::Asia::Kolkata
        .from_local_datetime(&naive)
        .single()
        .ok_or_else(|| NormalizeError::Timestamp(value.to_string()))?;
    Ok(zoned.timestamp())
}

/// Normalizes the `get_indian_stocks_ohlc` payload: sorted ascending, deduplicated
/// (last occurrence wins, matching "most recent data replaces older").
pub fn normalize_candles(payload: &Value) -> Result<Vec<Candle>, NormalizeError> {
    let entries = payload
        .get("candles")
        .and_then(|v| v.as_array())
        .ok_or(NormalizeError::Shape("candles"))?;
    let mut by_time: BTreeMap<i64, Candle> = BTreeMap::new();
    for entry in entries {
        let timestamp = entry
            .get("datetime_ist")
            .and_then(|v| v.as_str())
            .ok_or(NormalizeError::Shape("datetime_ist"))?;
        let candle = Candle {
            time: parse_ist_epoch(timestamp)?,
            open: number(entry, "open")?,
            high: number(entry, "high")?,
            low: number(entry, "low")?,
            close: number(entry, "close")?,
            volume: entry
                .get("volume")
                .and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)))
                .unwrap_or(0),
        };
        by_time.insert(candle.time, candle);
    }
    Ok(by_time.into_values().collect())
}

/// Maps the `lookup_ind_keys` payload (`[{ind_key, name}, …]`) to API results.
pub fn normalize_search(payload: &Value) -> Vec<Value> {
    payload
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let ind_key = item.get("ind_key")?.as_str()?;
                    let name = item.get("name").and_then(|v| v.as_str()).unwrap_or(ind_key);
                    Some(json!({ "indKey": ind_key, "name": name }))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Maps the `get_indian_stocks_details` payload (keyed by ind_key) to the quote shape
/// the UI header consumes.
pub fn normalize_quote(payload: &Value, ind_key: &str) -> Option<Value> {
    let entry = payload.get(ind_key)?;
    let basic = entry.get("entity_basic")?;
    let stats = entry.get("entity_stats")?;
    Some(json!({
        "indKey": ind_key,
        "name": basic
            .get("display_name")
            .or_else(|| basic.get("short_name"))
            .or_else(|| basic.get("name"))
            .and_then(|v| v.as_str()),
        "symbol": basic.get("symbol").and_then(|v| v.as_str()),
        "exchange": basic.get("exchange").and_then(|v| v.as_str()),
        "ltp": stats.get("live_price"),
        "change": stats.get("day_change"),
        "changePct": stats.get("day_change_percentage"),
        "prevClose": stats.get("prev_close"),
        "dayOpen": stats.get("day_open"),
        "dayHigh": stats.get("day_high"),
        "dayLow": stats.get("day_low"),
        "week52High": stats.get("52week_high"),
        "week52Low": stats.get("52week_low"),
        "volume": stats.get("volume"),
        "lastUpdated": stats.get("last_updated"),
    }))
}

fn number(entry: &Value, field: &'static str) -> Result<f64, NormalizeError> {
    entry
        .get(field)
        .and_then(|v| v.as_f64())
        .ok_or(NormalizeError::Number(field))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn epoch(rfc3339: &str) -> i64 {
        chrono::DateTime::parse_from_rfc3339(rfc3339).unwrap().timestamp()
    }

    #[test]
    fn parses_ist_wall_clock() {
        // 09:15 IST == 03:45 UTC
        assert_eq!(
            parse_ist_epoch("2026-09-17 09:15:00").unwrap(),
            epoch("2026-09-17T03:45:00Z")
        );
    }

    #[test]
    fn daily_bars_carry_utc_midnight_as_0530_ist() {
        // The verified quirk: daily bars come as 05:30:00, which is UTC midnight.
        assert_eq!(
            parse_ist_epoch("2025-09-17 05:30:00").unwrap(),
            epoch("2025-09-17T00:00:00Z")
        );
    }

    #[test]
    fn rejects_malformed_timestamps() {
        assert!(parse_ist_epoch("17-09-2025 09:15").is_err());
        assert!(parse_ist_epoch("not a date").is_err());
    }

    #[test]
    fn normalizes_candles_sorted_and_deduped_last_wins() {
        let payload = serde_json::json!({
            "ind_key": "INDS01052",
            "interval": "1day",
            "count": 3,
            "candles": [
                { "datetime_ist": "2025-09-19 05:30:00", "open": 1414.9, "high": 1417.0, "low": 1403.6, "close": 1407.4, "volume": 13461373 },
                { "datetime_ist": "2025-09-17 05:30:00", "open": 1407.0, "high": 1416.2, "low": 1406.9, "close": 1413.8, "volume": 7519417 },
                { "datetime_ist": "2025-09-18 05:30:00", "open": 1420.4, "high": 1422.0, "low": 1410.7, "close": 1415.0, "volume": 9332642 },
                { "datetime_ist": "2025-09-18 05:30:00", "open": 1420.4, "high": 1423.0, "low": 1410.7, "close": 1416.0, "volume": 9332642 }
            ]
        });
        let candles = normalize_candles(&payload).unwrap();
        assert_eq!(candles.len(), 3);
        assert_eq!(candles[0].time, epoch("2025-09-17T00:00:00Z"));
        assert_eq!(candles[1].close, 1416.0, "duplicate timestamp keeps the last value");
        assert!(candles.windows(2).all(|pair| pair[0].time < pair[1].time));
    }

    #[test]
    fn search_maps_ind_keys() {
        let payload = serde_json::json!([
            { "ind_key": "INDS01052", "name": "Reliance Industries" },
            { "ind_key": "INDS01338", "name": "Reliance Power" }
        ]);
        let results = normalize_search(&payload);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0]["indKey"], "INDS01052");
        assert_eq!(results[1]["name"], "Reliance Power");
    }

    #[test]
    fn quote_maps_details_payload() {
        // Trimmed from a live `get_indian_stocks_details` response.
        let payload = serde_json::json!({
            "INDS01052": {
                "entity_class": "STOCK",
                "entity_basic": {
                    "ind_key": "INDS01052",
                    "display_name": "Reliance Industries",
                    "symbol": "RELIANCE",
                    "exchange": "NSE"
                },
                "entity_stats": {
                    "live_price": 1243.9,
                    "day_change": 3.9,
                    "day_change_percentage": 0.31,
                    "prev_close": 1240,
                    "day_low": 1238.5,
                    "day_high": 1253.4,
                    "day_open": 1244.8,
                    "52week_high": 1611.8,
                    "52week_low": 1235.3,
                    "last_updated": "2026-09-17 16:01:09",
                    "volume": 7752895
                }
            }
        });
        let quote = normalize_quote(&payload, "INDS01052").unwrap();
        assert_eq!(quote["symbol"], "RELIANCE");
        assert_eq!(quote["ltp"], 1243.9);
        assert_eq!(quote["changePct"], 0.31);
        assert_eq!(quote["week52High"], 1611.8);
    }

    #[test]
    fn quote_returns_none_when_missing() {
        let payload = serde_json::json!({});
        assert!(normalize_quote(&payload, "NOPE").is_none());
    }
}
