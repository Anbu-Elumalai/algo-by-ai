import * as dotenv from "dotenv";
import * as path from "path";
import { MongoClient } from "mongodb";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

interface EvalLog {
  _id: any;
  date: string;
  timestamp: string;
  symbol: string;
  strategyVersion: string;
  candleTimestamp: string;
  signal: "BUY" | "HOLD" | "SELL";
  reason: string;
  tradeScore: number;
  indicators: {
    fastSMA: number;
    slowSMA: number;
    rsi: number;
    adx: number;
    atr: number;
    volume: number;
    averageVolume: number;
    ema50_1H: number;
    riskReward: number;
    choppiness: number;
    bbw: number;
  };
  filters: {
    goldenCross: boolean;
    rsi: boolean;
    adx: boolean;
    volume: boolean;
    trend1H: boolean;
    riskReward: boolean;
    sideways: boolean;
    tradeScore: boolean;
  };
  execution?: {
    orderPlaced: boolean;
    blockedReason?: string;
  };
  createdAt: Date;
}

async function run() {
  const mongoUri = process.env.MONGO_URI || "";
  const parsedUrl = new URL(mongoUri);
  parsedUrl.pathname = "/Algo";
  const client = new MongoClient(parsedUrl.toString());
  await client.connect();
  const db = client.db();

  console.log("Connected to MongoDB for audit...");

  // Load all evaluation logs for v2.x
  const allLogsRaw = await db.collection("strategy_evaluation_logs")
    .find({ strategyVersion: { $regex: /^2\./ } })
    .toArray();

  const evalLogs = allLogsRaw as unknown as EvalLog[];
  console.log(`Loaded ${evalLogs.length} strategy evaluation logs.`);

  if (evalLogs.length === 0) {
    console.error("No logs found for strategy version 2.x!");
    await client.close();
    return;
  }

  // Fetch all trade logs, strategy decisions, daily audits
  const tradeLogs = await db.collection("trade_logs").find({}).toArray();
  const strategyDecisions = await db.collection("strategy_decisions").find({}).toArray();
  const dailyAudits = await db.collection("runtime_daily_audits").find({}).toArray();

  console.log(`Trade logs: ${tradeLogs.length}`);
  console.log(`Strategy decisions: ${strategyDecisions.length}`);
  console.log(`Daily audits: ${dailyAudits.length}`);

  // ==========================================
  // STEP 1: Overall Evaluation Statistics
  // ==========================================
  const totalEvals = evalLogs.length;
  const buyLogs = evalLogs.filter(l => l.signal === "BUY");
  const sellLogs = evalLogs.filter(l => l.signal === "SELL");
  const holdLogs = evalLogs.filter(l => l.signal === "HOLD");

  const buyCount = buyLogs.length;
  const sellCount = sellLogs.length;
  const holdCount = holdLogs.length;

  const buyPct = (buyCount / totalEvals) * 100;
  const sellPct = (sellCount / totalEvals) * 100;
  const holdPct = (holdCount / totalEvals) * 100;

  let sumScore = 0;
  let sumAdx = 0;
  let sumRsi = 0;
  let sumAtr = 0;
  let sumRr = 0;
  let sumVolRatio = 0;

  evalLogs.forEach(l => {
    sumScore += l.tradeScore || 0;
    sumAdx += l.indicators?.adx || 0;
    sumRsi += l.indicators?.rsi || 0;
    sumAtr += l.indicators?.atr || 0;
    sumRr += l.indicators?.riskReward || 0;
    
    const vol = l.indicators?.volume || 0;
    const avgVol = l.indicators?.averageVolume || 1;
    sumVolRatio += vol / (avgVol || 1);
  });

  const avgScore = sumScore / totalEvals;
  const avgAdx = sumAdx / totalEvals;
  const avgRsi = sumRsi / totalEvals;
  const avgAtr = sumAtr / totalEvals;
  const avgRr = sumRr / totalEvals;
  const avgVolRatio = sumVolRatio / totalEvals;

  console.log("\n=== STEP 1: OVERALL STATISTICS ===");
  console.log(`Total Evaluations: ${totalEvals}`);
  console.log(`BUY: ${buyCount} (${buyPct.toFixed(2)}%)`);
  console.log(`SELL: ${sellCount} (${sellPct.toFixed(2)}%)`);
  console.log(`HOLD: ${holdCount} (${holdPct.toFixed(2)}%)`);
  console.log(`Average Trade Score: ${avgScore.toFixed(2)}`);
  console.log(`Average ADX: ${avgAdx.toFixed(2)}`);
  console.log(`Average RSI: ${avgRsi.toFixed(2)}`);
  console.log(`Average ATR: ${avgAtr.toFixed(2)}`);
  console.log(`Average Risk/Reward: ${avgRr.toFixed(2)}`);
  console.log(`Average Volume Ratio: ${avgVolRatio.toFixed(2)}`);

  // ==========================================
  // STEP 2: Individual Filter Effectiveness
  // ==========================================
  const filtersList = [
    { name: "Golden Cross", key: "goldenCross" },
    { name: "RSI", key: "rsi" },
    { name: "ADX", key: "adx" },
    { name: "Volume", key: "volume" },
    { name: "1H Trend", key: "trend1H" },
    { name: "Risk Reward", key: "riskReward" },
    { name: "Trade Score", key: "tradeScore" },
    { name: "Sideways Filter", key: "sideways" }
  ];

  const filterStats = filtersList.map(f => {
    let passed = 0;
    let failed = 0;
    evalLogs.forEach(l => {
      const val = l.filters ? (l.filters as any)[f.key] : false;
      if (val === true) passed++;
      else failed++;
    });
    return {
      filter: f.name,
      passed,
      failed,
      passPct: (passed / totalEvals) * 100,
      failPct: (failed / totalEvals) * 100
    };
  });

  console.log("\n=== STEP 2: FILTER EFFECTIVENESS TABLE ===");
  console.table(filterStats);

  // ==========================================
  // STEP 3: Primary Blocking Filter
  // ==========================================
  // Rank filters by overall fail rate
  const overallRanking = [...filterStats].sort((a, b) => b.failed - a.failed);

  // Also analyze actual crossover blocked events
  // A crossover blocked event is when goldenCross is true AND signal is HOLD AND it is a fresh crossover trigger.
  // Wait, let's identify how many evaluations were crossover-blocked.
  // Crossover blocked is when the reason contains "Golden Cross ignored due to:"
  const blockedCrossoverLogs = evalLogs.filter(l => l.signal === "HOLD" && l.reason.includes("ignored"));
  console.log(`\nCrossover-blocked HOLD logs (potential BUY opportunities blocked by filters): ${blockedCrossoverLogs.length}`);

  const blockedFilterCounts: Record<string, number> = {
    "Golden Cross": 0, // A crossover occurred, so Golden Cross itself passed
    "RSI": 0,
    "ADX": 0,
    "Volume": 0,
    "1H Trend": 0,
    "Risk Reward": 0,
    "Trade Score": 0,
    "Sideways Filter": 0
  };

  blockedCrossoverLogs.forEach(l => {
    // Check which other filters failed in these specific logs
    if (!l.filters.rsi) blockedFilterCounts["RSI"]++;
    if (!l.filters.adx) blockedFilterCounts["ADX"]++;
    if (!l.filters.volume) blockedFilterCounts["Volume"]++;
    if (!l.filters.trend1H) blockedFilterCounts["1H Trend"]++;
    if (!l.filters.riskReward) blockedFilterCounts["Risk Reward"]++;
    if (!l.filters.tradeScore) blockedFilterCounts["Trade Score"]++;
    if (!l.filters.sideways) blockedFilterCounts["Sideways Filter"]++;
  });

  const blockedRanking = Object.entries(blockedFilterCounts)
    .map(([filter, failed]) => ({
      filter,
      failed,
      pct: blockedCrossoverLogs.length > 0 ? (failed / blockedCrossoverLogs.length) * 100 : 0
    }))
    .sort((a, b) => b.failed - a.failed);

  console.log("\n=== STEP 3: OVERALL FILTER RESTRICTIVENESS (ALL EVALUATIONS) ===");
  overallRanking.forEach((r, idx) => {
    console.log(`${idx + 1}. ${r.filter} - Failed: ${r.failed} times (${r.failPct.toFixed(2)}%)`);
  });

  console.log("\n=== STEP 3: FILTER RESTRICTIVENESS ON ACTUAL CROSSOVERS (BLOCKED BUY OPPORTUNITIES) ===");
  blockedRanking.forEach((r, idx) => {
    console.log(`${idx + 1}. ${r.filter} - Blocked: ${r.failed} times (${r.pct.toFixed(2)}% of blocked crossovers)`);
  });

  // ==========================================
  // STEP 4: Ablation Analysis
  // ==========================================
  // We simulate each scenario independently.
  // Scenario A: Ignore ONLY Golden Cross.
  // Wait! If we ignore Golden Cross, does it mean we assume Golden Cross crossover occurs? Or do we assume that we check all evaluations where Golden Cross passed, or any evaluation at all?
  // Let's compute:
  // 1. How many BUY signals generated if we ignore the filter constraints?
  // Let's define:
  // A BUY occurs if:
  // - There is a crossover (reason contains "ignored" or signal was "BUY")
  // - AND all filters are true.
  // For each ablation scenario, we remove exactly ONE filter from the validation check of crossovers.
  // That is, we look at the crossover logs (signal === "BUY" or reason includes "ignored"), and check if all filters EXCEPT the ablated one are true.

  const crossoverLogs = evalLogs.filter(l => l.signal === "BUY" || l.reason.includes("ignored"));
  console.log(`\nTotal crossover events (BUY signals + blocked crossovers): ${crossoverLogs.length}`);

  const simulateAblationCrossover = (filterKeyToIgnore: string | null) => {
    let buyCountSim = 0;
    crossoverLogs.forEach(l => {
      let allPass = true;
      filtersList.forEach(f => {
        if (f.key === filterKeyToIgnore) return; // skip this filter
        if (f.key === "goldenCross") return; // Golden Cross crossover is already verified because it's a crossover event
        const pass = l.filters ? (l.filters as any)[f.key] : false;
        if (!pass) allPass = false;
      });
      // also check market hours time filter if not managing position? Wait, we'll assume standard log filters represent this.
      if (allPass) {
        buyCountSim++;
      }
    });
    return buyCountSim;
  };

  // What if we do NOT require crossover at all? That is, any evaluation where all other filters pass (Interpretation 2)
  const simulateAblationAllEvals = (filterKeyToIgnore: string | null) => {
    let buyCountSim = 0;
    evalLogs.forEach(l => {
      let allPass = true;
      filtersList.forEach(f => {
        if (f.key === filterKeyToIgnore) return;
        const pass = l.filters ? (l.filters as any)[f.key] : false;
        if (!pass) allPass = false;
      });
      if (allPass) {
        buyCountSim++;
      }
    });
    return buyCountSim;
  };

  const ablationCrossoverResults = [
    { name: "Golden Cross (crossover constraint)", key: "goldenCross" }, // If we ignore golden cross crossover constraint, then ANY evaluation where other filters pass is a BUY
    { name: "RSI", key: "rsi" },
    { name: "ADX", key: "adx" },
    { name: "Volume", key: "volume" },
    { name: "Risk Reward", key: "riskReward" },
    { name: "Trade Score", key: "tradeScore" },
    { name: "Sideways Filter", key: "sideways" }
  ].map(sc => {
    let simulatedBuys = 0;
    if (sc.key === "goldenCross") {
      // Ignoring Golden Cross crossover constraint means any evaluation that passes other filters.
      simulatedBuys = simulateAblationAllEvals("goldenCross");
    } else {
      simulatedBuys = simulateAblationCrossover(sc.key);
    }
    return {
      filterRemoved: sc.name,
      buysGenerated: simulatedBuys,
      diff: simulatedBuys - buyCount
    };
  });

  console.log("\n=== STEP 4: ABLATION ANALYSIS (CROSSOVER-CONSTRAINED) ===");
  console.table(ablationCrossoverResults);

  // Let's also do a raw filter ablation (if we look at all evaluations, how many pass all filters except the one ignored)
  const ablationAllResults = [
    { name: "Golden Cross", key: "goldenCross" },
    { name: "RSI", key: "rsi" },
    { name: "ADX", key: "adx" },
    { name: "Volume", key: "volume" },
    { name: "Risk Reward", key: "riskReward" },
    { name: "Trade Score", key: "tradeScore" },
    { name: "Sideways Filter", key: "sideways" }
  ].map(sc => {
    const simulatedBuys = simulateAblationAllEvals(sc.key);
    return {
      filterRemoved: sc.name,
      buysGenerated: simulatedBuys,
      diff: simulatedBuys - buyCount
    };
  });

  console.log("\n=== STEP 4: ABLATION ANALYSIS (ALL EVALUATIONS) ===");
  console.table(ablationAllResults);

  // ==========================================
  // STEP 5: Near Miss Analysis
  // ==========================================
  // Find top 50 closest BUY opportunities.
  // Let's rank from closest to BUY -> farthest.
  // How to score distance:
  // 1. Number of failed filters (ascending). Fewer failed filters = closer.
  // 2. Sum of normalized gaps.
  // Gaps:
  // - Trade Score Gap: Max(0, 60 - tradeScore)
  // - Risk Reward Gap: Max(0, 2.0 - rrRatio)
  // - ADX Gap: Max(0, 25 - adx)
  // - RSI Gap: If rsi < 55, gap = 55 - rsi. If rsi > 70, gap = rsi - 70. Else 0.
  // - Volume Gap: Max(0, averageVolume - volume)
  // Let's calculate gaps for every evaluation that was a HOLD, and sort them.

  const nearMisses = evalLogs.filter(l => l.signal === "HOLD").map(l => {
    const isCrossoverBlocked = l.reason.includes("ignored");
    const failedFiltersList: string[] = [];
    filtersList.forEach(f => {
      const pass = l.filters ? (l.filters as any)[f.key] : false;
      if (!pass) failedFiltersList.push(f.name);
    });

    const scoreVal = l.tradeScore || 0;
    const rrVal = l.indicators?.riskReward || 0;
    const adxVal = l.indicators?.adx || 0;
    const rsiVal = l.indicators?.rsi || 50;
    const volVal = l.indicators?.volume || 0;
    const avgVolVal = l.indicators?.averageVolume || 1;

    const scoreGap = Math.max(0, 60 - scoreVal);
    const rrGap = Math.max(0, 2.0 - rrVal);
    const adxGap = Math.max(0, 25 - adxVal);
    
    let rsiGap = 0;
    let rsiRange = "55-70";
    if (rsiVal < 55) {
      rsiGap = 55 - rsiVal;
    } else if (rsiVal > 70) {
      rsiGap = rsiVal - 70;
    }

    const volGap = Math.max(0, avgVolVal - volVal);

    // Normalized gaps
    const normScoreGap = scoreGap / 60;
    const normRrGap = rrGap / 2.0;
    const normAdxGap = adxGap / 25;
    const normRsiGap = rsiGap / 15;
    const normVolGap = volGap / (avgVolVal || 1);

    const totalNormGap = normScoreGap + normRrGap + normAdxGap + normRsiGap + normVolGap;

    return {
      id: l._id.toString(),
      timestamp: l.timestamp,
      date: l.date,
      symbol: l.symbol,
      reason: l.reason,
      isCrossoverBlocked,
      failedFiltersCount: failedFiltersList.length,
      failedFilters: failedFiltersList.join(", "),
      scoreVal, scoreGap,
      rrVal, rrGap,
      adxVal, adxGap,
      rsiVal, rsiGap, rsiRange,
      volVal, avgVolVal, volGap,
      totalNormGap
    };
  });

  // Sort near misses:
  // 1. Blocked crossover first? (Wait! A blocked crossover actually had a crossover trigger, so it's a true near miss).
  // Let's sort by isCrossoverBlocked (descending), then failedFiltersCount (ascending), then totalNormGap (ascending).
  const sortedNearMisses = [...nearMisses].sort((a, b) => {
    if (a.isCrossoverBlocked && !b.isCrossoverBlocked) return -1;
    if (!a.isCrossoverBlocked && b.isCrossoverBlocked) return 1;
    if (a.failedFiltersCount !== b.failedFiltersCount) {
      return a.failedFiltersCount - b.failedFiltersCount;
    }
    return a.totalNormGap - b.totalNormGap;
  }).slice(0, 50);

  console.log(`\n=== STEP 5: NEAR MISS ANALYSIS (Top 5 / 50) ===`);
  console.log(JSON.stringify(sortedNearMisses.slice(0, 5), null, 2));

  // ==========================================
  // STEP 6: Filter Combination Analysis
  // ==========================================
  const combCounts: Record<string, number> = {};
  holdLogs.forEach(l => {
    const failed: string[] = [];
    filtersList.forEach(f => {
      const pass = l.filters ? (l.filters as any)[f.key] : false;
      if (!pass) failed.push(f.name);
    });
    if (failed.length === 0) {
      failed.push("None (Passed All)");
    }
    failed.sort();
    const comb = failed.join(" + ");
    combCounts[comb] = (combCounts[comb] || 0) + 1;
  });

  const combinations = Object.entries(combCounts)
    .map(([combination, occurrences]) => ({
      combination,
      occurrences,
      pct: (occurrences / holdLogs.length) * 100
    }))
    .sort((a, b) => b.occurrences - a.occurrences);

  console.log("\n=== STEP 6: FILTER COMBINATION ANALYSIS ===");
  console.table(combinations.slice(0, 15));

  // ==========================================
  // STEP 7: Market Regime Classification
  // ==========================================
  // Classify every evaluation as:
  // - Breakout: Volume Ratio > 1.5 AND BBW > 0.03
  // - High Volatility: BBW >= 0.04 OR (ATR / Price) > 0.005
  // - Low Volatility: BBW < 0.01
  // - Trending: ADX >= 25 AND Choppiness <= 61.8
  // - Sideways: ADX < 25 OR Choppiness > 61.8 (Default fallback if none of above)
  
  const regimeStats: Record<string, { count: number; buyCount: number }> = {
    "Breakout": { count: 0, buyCount: 0 },
    "High Volatility": { count: 0, buyCount: 0 },
    "Low Volatility": { count: 0, buyCount: 0 },
    "Trending": { count: 0, buyCount: 0 },
    "Sideways": { count: 0, buyCount: 0 }
  };

  evalLogs.forEach(l => {
    const ind = l.indicators || {};
    const volRatio = (ind.volume || 0) / (ind.averageVolume || 1);
    const bbw = ind.bbw || 0;
    const atr = ind.atr || 0;
    const price = ind.fastSMA || 1; // proxy for price
    const adx = ind.adx || 0;
    const chop = ind.choppiness || 50;

    let regime = "Sideways";
    if (volRatio > 1.5 && bbw > 0.03) {
      regime = "Breakout";
    } else if (bbw >= 0.04 || (atr / price) > 0.005) {
      regime = "High Volatility";
    } else if (bbw < 0.01) {
      regime = "Low Volatility";
    } else if (adx >= 25 && chop <= 61.8) {
      regime = "Trending";
    } else {
      regime = "Sideways";
    }

    regimeStats[regime].count++;
    if (l.signal === "BUY") {
      regimeStats[regime].buyCount++;
    }
  });

  const marketRegimesReport = Object.entries(regimeStats).map(([regime, data]) => ({
    regime,
    evaluations: data.count,
    buyCount: data.buyCount,
    buyPct: data.count > 0 ? (data.buyCount / data.count) * 100 : 0
  }));

  console.log("\n=== STEP 7: MARKET REGIME ANALYSIS ===");
  console.table(marketRegimesReport);

  // ==========================================
  // STEP 8: Symbol Analysis
  // ==========================================
  const symbols = ["RELIANCE", "TCS", "INFY"];
  const symbolReports = symbols.map(sym => {
    const symLogs = evalLogs.filter(l => l.symbol === sym);
    const totalSym = symLogs.length;
    if (totalSym === 0) {
      return { symbol: sym, evaluations: 0, buys: 0, avgScore: 0, avgRr: 0, avgAdx: 0, avgRsi: 0, avgVolRatio: 0, mostFailedFilter: "N/A" };
    }
    const buys = symLogs.filter(l => l.signal === "BUY").length;
    
    let scoreSum = 0, rrSum = 0, adxSum = 0, rsiSum = 0, volRatioSum = 0;
    const filterFailures: Record<string, number> = {};

    symLogs.forEach(l => {
      scoreSum += l.tradeScore || 0;
      rrSum += l.indicators?.riskReward || 0;
      adxSum += l.indicators?.adx || 0;
      rsiSum += l.indicators?.rsi || 0;
      volRatioSum += (l.indicators?.volume || 0) / (l.indicators?.averageVolume || 1);

      filtersList.forEach(f => {
        const pass = l.filters ? (l.filters as any)[f.key] : false;
        if (!pass) {
          filterFailures[f.name] = (filterFailures[f.name] || 0) + 1;
        }
      });
    });

    const mostFailed = Object.entries(filterFailures).sort((a, b) => b[1] - a[1])[0];
    const mostFailedFilterName = mostFailed ? `${mostFailed[0]} (${mostFailed[1]} fails)` : "None";

    return {
      symbol: sym,
      evaluations: totalSym,
      buys,
      avgScore: scoreSum / totalSym,
      avgRr: rrSum / totalSym,
      avgAdx: adxSum / totalSym,
      avgRsi: rsiSum / totalSym,
      avgVolRatio: volRatioSum / totalSym,
      mostFailedFilter: mostFailedFilterName
    };
  });

  console.log("\n=== STEP 8: SYMBOL ANALYSIS ===");
  console.table(symbolReports);

  // ==========================================
  // STEP 9: Engineering Verification
  // ==========================================
  console.log("\n=== STEP 9: ENGINEERING VERIFICATION ===");
  
  // 1. Duplicate evaluations
  const seenEvals = new Set<string>();
  let duplicateEvalsCount = 0;
  evalLogs.forEach(l => {
    const key = `${l.symbol}-${l.candleTimestamp}`;
    if (seenEvals.has(key)) {
      duplicateEvalsCount++;
    }
    seenEvals.add(key);
  });
  console.log(`Duplicate evaluations (same symbol and candle timestamp): ${duplicateEvalsCount}`);

  // 2. Duplicate BUY
  const seenBuys = new Set<string>();
  let duplicateBuysCount = 0;
  buyLogs.forEach(l => {
    const key = `${l.symbol}-${l.candleTimestamp}`;
    if (seenBuys.has(key)) {
      duplicateBuysCount++;
    }
    seenBuys.add(key);
  });
  console.log(`Duplicate BUY signals (same symbol and candle timestamp): ${duplicateBuysCount}`);

  // 3. Incomplete candles
  let incompleteCandlesCount = 0;
  evalLogs.forEach(l => {
    const open = l.indicators?.fastSMA; // proxy for price presence
    const volume = l.indicators?.volume;
    if (open === 0 || volume === undefined) {
      incompleteCandlesCount++;
    }
  });
  console.log(`Incomplete candles (missing indicator values or zero price/volume): ${incompleteCandlesCount}`);

  // 4. Look-ahead bias
  // Evaluation timestamp (timestamp) versus Candle Open Timestamp (candleTimestamp)
  // Since timeframe is 15 minutes (or 1H for trend, but evaluation timeframe is 15 minutes),
  // a candle with open timestamp C closes at C + 15 minutes.
  // Evaluation timestamp E must be >= C + 15 minutes.
  let lookaheadBiasCount = 0;
  evalLogs.forEach(l => {
    const evalTime = new Date(l.timestamp).getTime();
    const candleOpenTime = new Date(l.candleTimestamp).getTime();
    const timeframeMs = 15 * 60 * 1000;
    if (evalTime < candleOpenTime + timeframeMs) {
      lookaheadBiasCount++;
    }
  });
  console.log(`Look-ahead bias evaluations (evaluated before candle closed): ${lookaheadBiasCount}`);

  // 5. Stale prices
  // Check if price remains exactly the same for several logs (e.g. 5 consecutive logs of the same symbol have identical fastSMA)
  let stalePricesCount = 0;
  const symLogsMap: Record<string, EvalLog[]> = {};
  evalLogs.forEach(l => {
    if (!symLogsMap[l.symbol]) symLogsMap[l.symbol] = [];
    symLogsMap[l.symbol].push(l);
  });

  Object.entries(symLogsMap).forEach(([sym, logs]) => {
    for (let i = 4; i < logs.length; i++) {
      const p0 = logs[i].indicators?.fastSMA;
      const p1 = logs[i-1].indicators?.fastSMA;
      const p2 = logs[i-2].indicators?.fastSMA;
      const p3 = logs[i-3].indicators?.fastSMA;
      const p4 = logs[i-4].indicators?.fastSMA;
      if (p0 === p1 && p1 === p2 && p2 === p3 && p3 === p4 && p0 !== 0) {
        stalePricesCount++;
      }
    }
  });
  console.log(`Stale price detections (5 consecutive flat prices): ${stalePricesCount}`);

  // 6. Reconciliation mismatch
  // Total execution errors, discrepancy between ordersExecuted and trade_logs
  // trade_logs count is 0. Let's see if any DailyAudit records execution metrics.
  let totalDailyAuditOrders = 0;
  dailyAudits.forEach(a => {
    totalDailyAuditOrders += (a.strategyStats?.ordersExecuted || 0);
  });
  console.log(`Daily Audit aggregated orders executed: ${totalDailyAuditOrders}`);
  console.log(`Actual trade logs documents: ${tradeLogs.length}`);
  const reconciliationMismatch = Math.abs(totalDailyAuditOrders - tradeLogs.length);
  console.log(`Reconciliation mismatch: ${reconciliationMismatch}`);

  // 7. Missing strategy logs
  // Expected logs per day versus actual.
  // 15m candle = 4 per hour. Trading session = 9:15 to 15:30 = 6 hours and 15 mins = 25 candles per symbol per day.
  // If there are 3 symbols, that's 75 evaluations per day.
  // Let's count unique dates and check if logs are missing.
  const uniqueDates = Array.from(new Set(evalLogs.map(l => l.date)));
  console.log(`Unique trading dates logged: ${uniqueDates.join(", ")}`);
  uniqueDates.forEach(d => {
    const dateEvals = evalLogs.filter(l => l.date === d).length;
    console.log(`- Date ${d}: ${dateEvals} evaluations (Expected ~75)`);
  });

  // Write all results to JSON file for consumption
  const reportObj = {
    step1: {
      totalEvals,
      buyCount, buyPct,
      sellCount, sellPct,
      holdCount, holdPct,
      avgScore,
      avgAdx,
      avgRsi,
      avgAtr,
      avgRr,
      avgVolRatio
    },
    step2: {
      filterStats
    },
    step3: {
      overallRanking,
      blockedCrossoverCount: blockedCrossoverLogs.length,
      blockedRanking
    },
    step4: {
      ablationCrossoverResults,
      ablationAllResults
    },
    step5: {
      top50NearMisses: sortedNearMisses
    },
    step6: {
      combinations
    },
    step7: {
      marketRegimesReport
    },
    step8: {
      symbolReports
    },
    step9: {
      duplicateEvalsCount,
      duplicateBuysCount,
      incompleteCandlesCount,
      lookaheadBiasCount,
      stalePricesCount,
      totalDailyAuditOrders,
      tradeLogsCount: tradeLogs.length,
      reconciliationMismatch,
      uniqueDates,
      dateBreakdown: uniqueDates.map(d => ({
        date: d,
        count: evalLogs.filter(l => l.date === d).length
      }))
    }
  };

  const outputFilePath = path.resolve(process.cwd(), "audit_results.json");
  await fs.promises.writeFile(outputFilePath, JSON.stringify(reportObj, null, 2), "utf8");
  console.log(`Audit complete! Results written to ${outputFilePath}`);

  await client.close();
}

run().catch(console.error);
import * as fs from "fs";
