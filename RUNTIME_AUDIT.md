# Runtime Daily Audit Specifications

This document outlines the schema details, scoring matrix, and manual generation guides for the daily runtime audit.

## Health Score Calculations

To certify the system for deployment, a dynamic multi-dimensional score is generated daily:

| Dimension | Weight | Measurement Rule |
| :--- | :--- | :--- |
| **Engineering Score** | 20% | Standard check: 100 if evaluations logged, 90 if boot checks pass but no ticks processed, 0 if crash detected. |
| **Infrastructure Score**| 20% | 100 if circuit state is CLOSED, 50 if circuit is OPEN/HALF_OPEN. |
| **Strategy Score** | 20% | 100 if no setups executed. 90 if win rate >= 50%, 60 if win rate < 50%. |
| **Risk Score** | 20% | 100 if daily loss halt is false, 50 if daily loss limits were breached. |
| **Performance Score** | 20% | 100 if net profit >= 0, 70 if session ended in a net loss. |

---

## Manual Generation Trigger

To manually force runtime audit creation for a specific session date (e.g. for testing, re-runs, or historical reviews):

1. **Trigger via HTTP API Route (Secured):**
   * **Route:** `GET /trading/runtime/:date`
   * **Result:** Returns the existing daily audit report or runs a live aggregation query.

2. **Trigger via CLI Script:**
   ```bash
   npx ts-node src/scripts/generate_daily_audit.ts --date=2026-07-03
   ```
