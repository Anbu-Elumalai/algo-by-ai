# System Telemetry & Monitoring Guide

This document describes how to monitor the health and performance of the trading bot.

## Telemetry Metrics

The system monitors real-time telemetry metrics:

| Metric | Source | Warning Threshold | Critical Threshold |
| :--- | :--- | :--- | :--- |
| **CPU Usage** | `SystemHealthMonitor.getHealthReport()` | > 80% | > 95% |
| **Heap Memory** | `process.memoryUsage().heapUsed` | > 1.2 GB | > 1.8 GB |
| **MongoDB Latency** | `SystemHealthMonitor` ping check | > 100 ms | > 500 ms |
| **WS Feed Latency** | Last tick age | > 200 ms | > 1000 ms |
| **REST API Latency** | Upstox HTTP call roundtrip | > 500 ms | > 2000 ms |
| **Order Execution Latency**| Broker place order delay | > 1000 ms | > 5000 ms |

---

## Grafana & Prometheus Integrations

The system exposes health status on a secured REST endpoint:
* **Endpoint:** `GET /trading/health`
* **Access:** Requires JWT Bearer token authentication.

```json
{
  "success": true,
  "data": {
    "bot": {
      "isActive": true,
      "mode": "PAPER"
    },
    "database": "connected",
    "system": {
      "cpuLoadAvg": [0.15, 0.22, 0.18],
      "freeMemoryBytes": 8589934592,
      "totalMemoryBytes": 17179869184,
      "memoryUsagePercent": 50.0
    }
  }
}
```
Set up a standard Prometheus alert scraper or datadog agent pointing to this endpoint to scrape metrics and trigger pager notifications if latency exceeds critical thresholds.
