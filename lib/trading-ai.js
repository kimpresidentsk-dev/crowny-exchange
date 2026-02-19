// ═══════════════════════════════════════════════════════════════
// Crowny Trading AI v1.0
// Technical Analysis · Multi-Strategy · Risk Management · Backtesting
// 3-Trit Consensus: Positive(매수)/Omit(관망)/Trigger(매도)
// ═══════════════════════════════════════════════════════════════

// ─── Technical Indicators ────────────────────────────────────

function SMA(data, period) {
  const result = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { result.push(null); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += data[j];
    result.push(sum / period);
  }
  return result;
}

function EMA(data, period) {
  const result = []; const k = 2 / (period + 1);
  let ema = null;
  for (let i = 0; i < data.length; i++) {
    if (i === 0) { ema = data[i]; }
    else { ema = data[i] * k + ema * (1 - k); }
    result.push(i < period - 1 ? null : ema);
  }
  return result;
}

function RSI(closes, period = 14) {
  const result = []; let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < closes.length; i++) {
    if (i === 0) { result.push(null); continue; }
    const change = closes[i] - closes[i-1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    if (i <= period) {
      avgGain += gain / period; avgLoss += loss / period;
      result.push(i < period ? null : (avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)));
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
    }
  }
  return result;
}

function MACD(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = EMA(closes, fast);
  const emaSlow = EMA(closes, slow);
  const macdLine = emaFast.map((v, i) => v && emaSlow[i] ? v - emaSlow[i] : null);
  const macdValid = macdLine.filter(v => v !== null);
  const signalLine = EMA(macdValid, signal);
  const result = [];
  let si = 0;
  for (let i = 0; i < macdLine.length; i++) {
    if (macdLine[i] === null) { result.push({ macd: null, signal: null, histogram: null }); }
    else {
      const s = si < signalLine.length ? signalLine[si] : null;
      result.push({ macd: macdLine[i], signal: s, histogram: s !== null ? macdLine[i] - s : null });
      si++;
    }
  }
  return result;
}

function BollingerBands(closes, period = 20, stdDev = 2) {
  const sma = SMA(closes, period);
  const result = [];
  for (let i = 0; i < closes.length; i++) {
    if (sma[i] === null) { result.push({ upper: null, mid: null, lower: null, width: null }); continue; }
    let sumSq = 0;
    for (let j = i - period + 1; j <= i; j++) sumSq += (closes[j] - sma[i]) ** 2;
    const std = Math.sqrt(sumSq / period);
    result.push({ upper: sma[i] + stdDev * std, mid: sma[i], lower: sma[i] - stdDev * std, width: (4 * stdDev * std) / sma[i] });
  }
  return result;
}

function Stochastic(highs, lows, closes, kPeriod = 14, dPeriod = 3) {
  const kValues = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < kPeriod - 1) { kValues.push(null); continue; }
    let hh = -Infinity, ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) { hh = Math.max(hh, highs[j]); ll = Math.min(ll, lows[j]); }
    kValues.push(hh === ll ? 50 : ((closes[i] - ll) / (hh - ll)) * 100);
  }
  const dValues = SMA(kValues.map(v => v || 0), dPeriod);
  return kValues.map((k, i) => ({ k, d: dValues[i] }));
}

function ATR(highs, lows, closes, period = 14) {
  const trs = [0];
  for (let i = 1; i < closes.length; i++) {
    trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1])));
  }
  return SMA(trs, period);
}

function VWAP(highs, lows, closes, volumes) {
  let cumVol = 0, cumTP = 0;
  return closes.map((c, i) => {
    const tp = (highs[i] + lows[i] + c) / 3;
    cumVol += volumes[i]; cumTP += tp * volumes[i];
    return cumVol === 0 ? c : cumTP / cumVol;
  });
}

function OBV(closes, volumes) {
  const result = [0];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i-1]) result.push(result[i-1] + volumes[i]);
    else if (closes[i] < closes[i-1]) result.push(result[i-1] - volumes[i]);
    else result.push(result[i-1]);
  }
  return result;
}

// ─── Trading Strategies ──────────────────────────────────────

class Strategy {
  constructor(name, weight = 1) { this.name = name; this.weight = weight; }
  // Returns: { signal: 1(buy)/0(hold)/-1(sell), confidence: 0-1, reason: string }
  analyze(candles) { return { signal: 0, confidence: 0, reason: 'base' }; }
}

class RSIStrategy extends Strategy {
  constructor(period = 14, oversold = 30, overbought = 70) {
    super('RSI', 1.5); this.period = period; this.os = oversold; this.ob = overbought;
  }
  analyze(candles) {
    const closes = candles.map(c => c.close);
    const rsi = RSI(closes, this.period);
    const current = rsi[rsi.length - 1];
    const prev = rsi[rsi.length - 2];
    if (!current) return { signal: 0, confidence: 0, reason: 'RSI 데이터 부족' };
    if (current < this.os && prev && prev >= this.os) return { signal: 1, confidence: 0.8, reason: `RSI ${current.toFixed(1)} 과매도 진입 (↗반등 기대)` };
    if (current < this.os) return { signal: 1, confidence: 0.6, reason: `RSI ${current.toFixed(1)} 과매도 구간` };
    if (current > this.ob && prev && prev <= this.ob) return { signal: -1, confidence: 0.8, reason: `RSI ${current.toFixed(1)} 과매수 진입 (↘조정 기대)` };
    if (current > this.ob) return { signal: -1, confidence: 0.6, reason: `RSI ${current.toFixed(1)} 과매수 구간` };
    if (current > 45 && current < 55) return { signal: 0, confidence: 0.3, reason: `RSI ${current.toFixed(1)} 중립` };
    return { signal: current < 50 ? 1 : -1, confidence: 0.3, reason: `RSI ${current.toFixed(1)}` };
  }
}

class MACDStrategy extends Strategy {
  constructor() { super('MACD', 1.3); }
  analyze(candles) {
    const closes = candles.map(c => c.close);
    const macd = MACD(closes);
    const cur = macd[macd.length - 1];
    const prev = macd[macd.length - 2];
    if (!cur.macd || !cur.signal) return { signal: 0, confidence: 0, reason: 'MACD 데이터 부족' };
    // 골든크로스
    if (cur.macd > cur.signal && prev.macd && prev.macd <= prev.signal)
      return { signal: 1, confidence: 0.85, reason: 'MACD 골든크로스 🔥' };
    // 데드크로스
    if (cur.macd < cur.signal && prev.macd && prev.macd >= prev.signal)
      return { signal: -1, confidence: 0.85, reason: 'MACD 데드크로스 ❄️' };
    // 히스토그램 방향
    if (cur.histogram > 0 && cur.histogram > (prev.histogram || 0))
      return { signal: 1, confidence: 0.5, reason: `MACD 히스토그램 확대 (+${cur.histogram.toFixed(2)})` };
    if (cur.histogram < 0 && cur.histogram < (prev.histogram || 0))
      return { signal: -1, confidence: 0.5, reason: `MACD 히스토그램 확대 (${cur.histogram.toFixed(2)})` };
    return { signal: 0, confidence: 0.2, reason: 'MACD 횡보' };
  }
}

class BollingerStrategy extends Strategy {
  constructor() { super('Bollinger', 1.2); }
  analyze(candles) {
    const closes = candles.map(c => c.close);
    const bb = BollingerBands(closes);
    const cur = bb[bb.length - 1]; const price = closes[closes.length - 1];
    if (!cur.upper) return { signal: 0, confidence: 0, reason: 'BB 데이터 부족' };
    const pos = (price - cur.lower) / (cur.upper - cur.lower);
    if (pos < 0.05) return { signal: 1, confidence: 0.8, reason: `가격 하단밴드 터치 (${(pos*100).toFixed(1)}%)` };
    if (pos < 0.2) return { signal: 1, confidence: 0.5, reason: `가격 하단 접근 (${(pos*100).toFixed(1)}%)` };
    if (pos > 0.95) return { signal: -1, confidence: 0.8, reason: `가격 상단밴드 터치 (${(pos*100).toFixed(1)}%)` };
    if (pos > 0.8) return { signal: -1, confidence: 0.5, reason: `가격 상단 접근 (${(pos*100).toFixed(1)}%)` };
    if (cur.width < 0.03) return { signal: 0, confidence: 0.7, reason: `밴드 수축 — 변동성 확대 임박 (width:${(cur.width*100).toFixed(2)}%)` };
    return { signal: 0, confidence: 0.2, reason: `BB 중립 (${(pos*100).toFixed(1)}%)` };
  }
}

class VolumeStrategy extends Strategy {
  constructor() { super('Volume', 0.8); }
  analyze(candles) {
    if (candles.length < 21) return { signal: 0, confidence: 0, reason: '데이터 부족' };
    const vols = candles.map(c => c.volume);
    const avgVol = vols.slice(-20).reduce((a,b)=>a+b,0) / 20;
    const curVol = vols[vols.length - 1];
    const ratio = curVol / avgVol;
    const priceChange = (candles[candles.length-1].close - candles[candles.length-2].close) / candles[candles.length-2].close;
    if (ratio > 2.5 && priceChange > 0.02) return { signal: 1, confidence: 0.7, reason: `거래량 폭증 (${ratio.toFixed(1)}x) + 상승` };
    if (ratio > 2.5 && priceChange < -0.02) return { signal: -1, confidence: 0.7, reason: `거래량 폭증 (${ratio.toFixed(1)}x) + 하락` };
    if (ratio > 1.5) return { signal: priceChange > 0 ? 1 : -1, confidence: 0.4, reason: `거래량 증가 (${ratio.toFixed(1)}x)` };
    if (ratio < 0.3) return { signal: 0, confidence: 0.5, reason: `거래량 급감 — 관망` };
    return { signal: 0, confidence: 0.1, reason: `거래량 보통 (${ratio.toFixed(1)}x)` };
  }
}

class TrendStrategy extends Strategy {
  constructor() { super('Trend', 1.0); }
  analyze(candles) {
    const closes = candles.map(c => c.close);
    const ema20 = EMA(closes, 20);
    const ema50 = EMA(closes, 50);
    const ema200 = EMA(closes, 200);
    const cur = closes[closes.length - 1];
    const e20 = ema20[ema20.length - 1];
    const e50 = ema50[ema50.length - 1];
    const e200 = ema200[ema200.length - 1];
    if (!e20 || !e50) return { signal: 0, confidence: 0, reason: '추세 데이터 부족' };
    // 강한 상승 추세: 가격 > EMA20 > EMA50 > EMA200
    if (cur > e20 && e20 > e50 && e200 && e50 > e200) return { signal: 1, confidence: 0.8, reason: '강한 상승 추세 (P>20>50>200)' };
    if (cur > e20 && e20 > e50) return { signal: 1, confidence: 0.6, reason: '상승 추세 (P>20>50)' };
    // 강한 하락 추세
    if (cur < e20 && e20 < e50 && e200 && e50 < e200) return { signal: -1, confidence: 0.8, reason: '강한 하락 추세 (P<20<50<200)' };
    if (cur < e20 && e20 < e50) return { signal: -1, confidence: 0.6, reason: '하락 추세 (P<20<50)' };
    // 골든/데드 크로스
    const pe20 = ema20[ema20.length - 2]; const pe50 = ema50[ema50.length - 2];
    if (pe20 && pe50 && pe20 <= pe50 && e20 > e50) return { signal: 1, confidence: 0.9, reason: 'EMA 골든크로스 (20↗50)' };
    if (pe20 && pe50 && pe20 >= pe50 && e20 < e50) return { signal: -1, confidence: 0.9, reason: 'EMA 데드크로스 (20↘50)' };
    return { signal: 0, confidence: 0.3, reason: '추세 전환 구간' };
  }
}

class StochasticStrategy extends Strategy {
  constructor() { super('Stochastic', 0.7); }
  analyze(candles) {
    const stoch = Stochastic(candles.map(c => c.high), candles.map(c => c.low), candles.map(c => c.close));
    const cur = stoch[stoch.length - 1];
    if (!cur.k) return { signal: 0, confidence: 0, reason: 'Stochastic 데이터 부족' };
    if (cur.k < 20 && cur.d && cur.k > cur.d) return { signal: 1, confidence: 0.7, reason: `Stoch 과매도 + K>D (K:${cur.k.toFixed(1)})` };
    if (cur.k < 20) return { signal: 1, confidence: 0.5, reason: `Stoch 과매도 (K:${cur.k.toFixed(1)})` };
    if (cur.k > 80 && cur.d && cur.k < cur.d) return { signal: -1, confidence: 0.7, reason: `Stoch 과매수 + K<D (K:${cur.k.toFixed(1)})` };
    if (cur.k > 80) return { signal: -1, confidence: 0.5, reason: `Stoch 과매수 (K:${cur.k.toFixed(1)})` };
    return { signal: 0, confidence: 0.2, reason: `Stoch 중립 (K:${cur.k.toFixed(1)})` };
  }
}

// ─── Risk Manager ────────────────────────────────────────────

class RiskManager {
  constructor(config = {}) {
    this.maxPositionSize = config.maxPositionSize || 0.1;  // 총 자산의 10%
    this.maxDrawdown = config.maxDrawdown || 0.15;         // 최대 15% 손실
    this.stopLossPercent = config.stopLoss || 0.03;        // 3% 손절
    this.takeProfitPercent = config.takeProfit || 0.06;    // 6% 익절
    this.maxDailyTrades = config.maxDailyTrades || 10;
    this.dailyTrades = 0;
    this.peakBalance = 0;
    this.positions = {};
  }

  checkRisk(action, symbol, price, balance) {
    const risks = [];
    // 일일 거래 제한
    if (this.dailyTrades >= this.maxDailyTrades) {
      risks.push({ level: 'block', reason: `일일 거래 한도 초과 (${this.maxDailyTrades})` });
    }
    // 최대 드로다운 체크
    if (balance > this.peakBalance) this.peakBalance = balance;
    const drawdown = (this.peakBalance - balance) / this.peakBalance;
    if (drawdown > this.maxDrawdown) {
      risks.push({ level: 'block', reason: `최대 드로다운 초과 (${(drawdown*100).toFixed(1)}% > ${(this.maxDrawdown*100)}%)` });
    }
    // 포지션 크기 제한
    const maxSize = balance * this.maxPositionSize;
    // 기존 포지션 손절/익절 체크
    if (this.positions[symbol]) {
      const pos = this.positions[symbol];
      const pnl = (price - pos.entryPrice) / pos.entryPrice;
      if (pnl < -this.stopLossPercent) {
        risks.push({ level: 'stoploss', reason: `손절 트리거 (${(pnl*100).toFixed(2)}% < -${(this.stopLossPercent*100)}%)` });
      }
      if (pnl > this.takeProfitPercent) {
        risks.push({ level: 'takeprofit', reason: `익절 트리거 (${(pnl*100).toFixed(2)}% > +${(this.takeProfitPercent*100)}%)` });
      }
    }
    const blocked = risks.some(r => r.level === 'block');
    return { allowed: !blocked, risks, maxSize, drawdown: (drawdown * 100).toFixed(2) };
  }

  recordTrade(symbol, side, price, amount) {
    this.dailyTrades++;
    if (side === 'buy') {
      this.positions[symbol] = { entryPrice: price, amount, ts: Date.now() };
    } else if (side === 'sell' && this.positions[symbol]) {
      delete this.positions[symbol];
    }
  }

  resetDaily() { this.dailyTrades = 0; }
}

// ─── Trading AI (3-Trit Consensus) ──────────────────────────

class TradingAI {
  constructor(config = {}) {
    this.strategies = [
      new RSIStrategy(),
      new MACDStrategy(),
      new BollingerStrategy(),
      new VolumeStrategy(),
      new TrendStrategy(),
      new StochasticStrategy(),
    ];
    this.riskManager = new RiskManager(config.risk || {});
    this.tradeLog = [];
    this.backtest = { trades: [], equity: [] };
  }

  // 3-Trit Consensus: 각 전략의 가중 투표 → 최종 결정
  analyze(candles, symbol = 'UNKNOWN', balance = 100000) {
    if (!candles || candles.length < 50) {
      return { decision: 'hold', trit: 0, confidence: 0, strategies: [], risk: null, reason: '데이터 부족 (최소 50개 캔들 필요)' };
    }

    const results = this.strategies.map(s => {
      const r = s.analyze(candles);
      return { name: s.name, weight: s.weight, ...r };
    });

    // 가중 투표
    let weightedSum = 0, totalWeight = 0, totalConfidence = 0;
    for (const r of results) {
      if (r.confidence > 0) {
        weightedSum += r.signal * r.weight * r.confidence;
        totalWeight += r.weight * r.confidence;
        totalConfidence += r.confidence;
      }
    }

    const avgScore = totalWeight > 0 ? weightedSum / totalWeight : 0;
    const avgConfidence = results.length > 0 ? totalConfidence / results.length : 0;

    // 3-Trit 결정
    let decision, trit;
    if (avgScore > 0.3) { decision = 'buy'; trit = 1; }
    else if (avgScore < -0.3) { decision = 'sell'; trit = -1; }
    else { decision = 'hold'; trit = 0; }

    // 리스크 체크
    const currentPrice = candles[candles.length - 1].close;
    const risk = this.riskManager.checkRisk(decision, symbol, currentPrice, balance);
    if (!risk.allowed && decision !== 'hold') {
      decision = 'hold'; trit = 0;
    }

    // 손절/익절 우선
    const stoploss = risk.risks.find(r => r.level === 'stoploss');
    const takeprofit = risk.risks.find(r => r.level === 'takeprofit');
    if (stoploss) { decision = 'sell'; trit = -1; }
    if (takeprofit) { decision = 'sell'; trit = -1; }

    const tritStr = trit === 1 ? 'P(매수)' : trit === -1 ? 'T(매도)' : 'O(관망)';

    return {
      symbol, decision, trit, tritStr,
      score: avgScore.toFixed(3),
      confidence: avgConfidence.toFixed(3),
      strategies: results.filter(r => r.confidence > 0).map(r => ({
        name: r.name, signal: r.signal === 1 ? '매수' : r.signal === -1 ? '매도' : '관망',
        confidence: (r.confidence * 100).toFixed(0) + '%', reason: r.reason
      })),
      risk: { allowed: risk.allowed, drawdown: risk.drawdown, maxSize: risk.maxSize, risks: risk.risks },
      price: currentPrice,
      reason: `${tritStr} | Score: ${avgScore.toFixed(3)} | ${results.filter(r => r.signal === 1).length}매수/${results.filter(r => r.signal === 0).length}관망/${results.filter(r => r.signal === -1).length}매도`
    };
  }

  // 백테스트
  runBacktest(candles, initialBalance = 10_000_000) {
    const equity = [initialBalance];
    let balance = initialBalance;
    let position = null;
    const trades = [];

    for (let i = 50; i < candles.length; i++) {
      const slice = candles.slice(0, i + 1);
      const result = this.analyze(slice, 'BACKTEST', balance + (position ? position.amount * candles[i].close : 0));

      if (result.decision === 'buy' && !position) {
        const amount = Math.floor(balance * 0.1 / candles[i].close * 100) / 100; // 10% 포지션
        const cost = amount * candles[i].close;
        if (cost <= balance) {
          balance -= cost;
          position = { amount, entryPrice: candles[i].close, entryIdx: i };
          trades.push({ type: 'buy', price: candles[i].close, amount, idx: i, ts: candles[i].ts });
        }
      } else if (result.decision === 'sell' && position) {
        const revenue = position.amount * candles[i].close;
        const pnl = revenue - position.amount * position.entryPrice;
        balance += revenue;
        trades.push({ type: 'sell', price: candles[i].close, amount: position.amount, pnl, idx: i, ts: candles[i].ts });
        position = null;
      }

      const total = balance + (position ? position.amount * candles[i].close : 0);
      equity.push(total);
    }

    // 미결 포지션 정리
    if (position) {
      const lastPrice = candles[candles.length - 1].close;
      balance += position.amount * lastPrice;
    }

    const totalReturn = ((balance - initialBalance) / initialBalance * 100).toFixed(2);
    const wins = trades.filter(t => t.type === 'sell' && t.pnl > 0).length;
    const losses = trades.filter(t => t.type === 'sell' && t.pnl <= 0).length;
    const winRate = (wins + losses) > 0 ? (wins / (wins + losses) * 100).toFixed(1) : '0';

    // 최대 드로다운
    let peak = equity[0], maxDD = 0;
    for (const v of equity) {
      if (v > peak) peak = v;
      const dd = (peak - v) / peak;
      if (dd > maxDD) maxDD = dd;
    }

    // 샤프 비율 (근사)
    const returns = [];
    for (let i = 1; i < equity.length; i++) returns.push((equity[i] - equity[i-1]) / equity[i-1]);
    const avgReturn = returns.reduce((a,b) => a+b, 0) / returns.length;
    const stdReturn = Math.sqrt(returns.reduce((a,b) => a + (b - avgReturn) ** 2, 0) / returns.length);
    const sharpe = stdReturn > 0 ? (avgReturn / stdReturn * Math.sqrt(252)).toFixed(2) : '0';

    return {
      initialBalance, finalBalance: Math.round(balance),
      totalReturn: totalReturn + '%',
      totalTrades: trades.filter(t => t.type === 'sell').length,
      wins, losses, winRate: winRate + '%',
      maxDrawdown: (maxDD * 100).toFixed(2) + '%',
      sharpeRatio: sharpe,
      trades, equity
    };
  }
}

module.exports = {
  TradingAI, RiskManager,
  RSIStrategy, MACDStrategy, BollingerStrategy, VolumeStrategy, TrendStrategy, StochasticStrategy,
  SMA, EMA, RSI, MACD, BollingerBands, Stochastic, ATR, VWAP, OBV
};
