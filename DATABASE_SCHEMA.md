# Database Schema Documentation

This document describes the collections added for continuous auditing and strategy evaluation.

## Collections

### 1. `strategy_evaluation_logs`
Stores every strategy execution evaluation on every symbol.

* **Schema:**
  * `_id` (`ObjectId`): MongoDB document identifier.
  * `date` (`String`): YYYY-MM-DD format (indexed).
  * `timestamp` (`String`): ISO timestamp.
  * `symbol` (`String`): Ticker symbol e.g. "RELIANCE" (indexed).
  * `strategyVersion` (`String`): Active strategy version (e.g. "2.0").
  * `candleTimestamp` (`String`): Open timestamp of the evaluated completed candle.
  * `signal` (`"BUY" | "HOLD" | "SELL"`): Strategy action signal.
  * `reason` (`String`): Explanation of the signal.
  * `tradeScore` (`Number`): Numeric quality score (0-100).
  * `indicators` (`Object`):
    * `fastSMA` (`Number`)
    * `slowSMA` (`Number`)
    * `rsi` (`Number`)
    * `adx` (`Number`)
    * `atr` (`Number`)
    * `volume` (`Number`)
    * `averageVolume` (`Number`)
    * `ema50_1H` (`Number`)
    * `riskReward` (`Number`)
    * `choppiness` (`Number`)
    * `bbw` (`Number`)
  * `filters` (`Object`):
    * `goldenCross` (`Boolean`)
    * `rsi` (`Boolean`)
    * `adx` (`Boolean`)
    * `volume` (`Boolean`)
    * `trend1H` (`Boolean`)
    * `riskReward` (`Boolean`)
    * `sideways` (`Boolean`)
    * `tradeScore` (`Boolean`)
  * `execution` (`Object`):
    * `orderPlaced` (`Boolean`)
    * `blockedReason` (`String`, optional)
  * `createdAt` (`Date`): Creation timestamp.

---

### 2. `runtime_daily_audits`
Stores daily aggregated trading metrics, filter statistics, and system health grades.

* **Schema:**
  * `_id` (`ObjectId`): Document identifier.
  * `date` (`String`): YYYY-MM-DD format (unique, indexed).
  * `sessionInfo` (`Object`):
    * `marketOpen` (`String`)
    * `marketClose` (`String`)
    * `botUptime` (`Number`)
    * `tradingMode` (`String`)
    * `strategyVersion` (`String`)
  * `strategyStats` (`Object`):
    * `evaluations` (`Number`)
    * `buyCount` (`Number`)
    * `sellCount` (`Number`)
    * `holdCount` (`Number`)
    * `ordersExecuted` (`Number`)
    * `ordersRejected` (`Number`)
    * `completedTrades` (`Number`)
    * `openTrades` (`Number`)
  * `filterStats` (`Object`):
    * `goldenCrossFailures` (`Number`)
    * `rsiFailures` (`Number`)
    * `adxFailures` (`Number`)
    * `volumeFailures` (`Number`)
    * `trend1HFailures` (`Number`)
    * `riskRewardFailures` (`Number`)
    * `tradeScoreFailures` (`Number`)
    * `sidewaysFailures` (`Number`)
    * `topRejectionReason` (`String`)
    * `secondRejectionReason` (`String`)
  * `performance` (`Object`):
    * `winRate` (`Number`)
    * `lossRate` (`Number`)
    * `profitFactor` (`Number`)
    * `expectancy` (`Number`)
    * `grossProfit` (`Number`)
    * `grossLoss` (`Number`)
    * `netProfit` (`Number`)
    * `drawdown` (`Number`)
    * `sharpe` (`Number`)
    * `sortino` (`Number`)
    * `calmar` (`Number`)
    * `recoveryFactor` (`Number`)
  * `risk` (`Object`):
    * `startingEquity` (`Number`)
    * `endingEquity` (`Number`)
    * `peakEquity` (`Number`)
    * `lowestEquity` (`Number`)
    * `maxDrawdown` (`Number`)
    * `dailyRiskHalt` (`Boolean`)
    * `circuitBreaker` (`String`)
    * `trailingStopHits` (`Number`)
    * `atrStopHits` (`Number`)
  * `infrastructure` (`Object`):
    * `webSocketDisconnects` (`Number`)
    * `webSocketReconnects` (`Number`)
    * `restFailures` (`Number`)
    * `tokenRefreshes` (`Number`)
    * `priceEngineHealth` (`String`)
    * `feedLatency` (`Number`)
    * `cacheSyncStatus` (`String`)
    * `positionReconciliationStatus` (`String`)
  * `healthScore` (`Object`):
    * `engineeringScore` (`Number`)
    * `infrastructureScore` (`Number`)
    * `strategyScore` (`Number`)
    * `riskScore` (`Number`)
    * `performanceScore` (`Number`)
    * `overallScore` (`Number`)
  * `createdAt` (`Date`): Log creation timestamp.

---

### 3. `weekly_analytics_reports`
Holds weekly aggregated statistics and rolling breakdowns.

---

### 4. `monthly_certification_reports`
Holds monthly institutional-grade verification audits.
