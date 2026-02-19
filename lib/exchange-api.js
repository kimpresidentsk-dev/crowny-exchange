// ═══════════════════════════════════════════════════════════════
// Exchange API Connectors — Upbit · Binance · (Future: Stocks/Futures)
// Real REST API integration with rate limiting + error handling
// ═══════════════════════════════════════════════════════════════

const https = require('https');
const crypto = require('crypto');

// ─── HTTP Helper ─────────────────────────────────────────────
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = { hostname: u.hostname, path: u.pathname + u.search, headers: { 'User-Agent': 'CrownyTrader/1.0', ...headers } };
    https.get(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { resolve(data); }
      });
    }).on('error', reject);
  });
}

function httpRequest(method, url, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      method, hostname: u.hostname, path: u.pathname + u.search,
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'CrownyTrader/1.0', ...headers }
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve(data); } });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════
// UPBIT CONNECTOR
// ═══════════════════════════════════════════════════════════════
class UpbitConnector {
  constructor(accessKey = '', secretKey = '') {
    this.baseUrl = 'https://api.upbit.com/v1';
    this.accessKey = accessKey; this.secretKey = secretKey;
    this.rateLimit = { lastCall: 0, minInterval: 100 };
    this.cache = {};
  }

  async _throttle() {
    const now = Date.now();
    const wait = this.rateLimit.minInterval - (now - this.rateLimit.lastCall);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    this.rateLimit.lastCall = Date.now();
  }

  // --- Public APIs (인증 불필요) ---

  async getMarkets() {
    await this._throttle();
    try {
      const data = await httpGet(`${this.baseUrl}/market/all?isDetails=true`);
      return Array.isArray(data) ? data.map(m => ({
        market: m.market, korean: m.korean_name, english: m.english_name,
        warning: m.market_warning || 'NONE'
      })) : [];
    } catch(e) { return []; }
  }

  async getTicker(markets) {
    await this._throttle();
    const mkts = Array.isArray(markets) ? markets.join(',') : markets;
    try {
      const data = await httpGet(`${this.baseUrl}/ticker?markets=${mkts}`);
      return Array.isArray(data) ? data.map(t => ({
        market: t.market, price: t.trade_price, open: t.opening_price,
        high: t.high_price, low: t.low_price, volume: t.acc_trade_volume_24h,
        volumeKRW: t.acc_trade_price_24h, change: t.change,
        changeRate: t.signed_change_rate, changePrice: t.signed_change_price,
        timestamp: t.timestamp
      })) : [];
    } catch(e) { return []; }
  }

  async getCandles(market, unit = 'minutes', count = 200, minuteUnit = 60) {
    await this._throttle();
    const endpoint = unit === 'minutes'
      ? `${this.baseUrl}/candles/${unit}/${minuteUnit}?market=${market}&count=${count}`
      : `${this.baseUrl}/candles/${unit}?market=${market}&count=${count}`;
    try {
      const data = await httpGet(endpoint);
      return Array.isArray(data) ? data.map(c => ({
        ts: new Date(c.candle_date_time_kst).getTime(),
        open: c.opening_price, high: c.high_price,
        low: c.low_price, close: c.trade_price,
        volume: c.candle_acc_trade_volume
      })).reverse() : [];
    } catch(e) { return []; }
  }

  async getOrderbook(markets) {
    await this._throttle();
    const mkts = Array.isArray(markets) ? markets.join(',') : markets;
    try {
      const data = await httpGet(`${this.baseUrl}/orderbook?markets=${mkts}`);
      return Array.isArray(data) ? data.map(ob => ({
        market: ob.market,
        asks: (ob.orderbook_units || []).map(u => ({ price: u.ask_price, size: u.ask_size })),
        bids: (ob.orderbook_units || []).map(u => ({ price: u.bid_price, size: u.bid_size })),
        totalAsk: ob.total_ask_size, totalBid: ob.total_bid_size
      })) : [];
    } catch(e) { return []; }
  }

  // --- Private APIs (인증 필요) ---

  _signRequest(queryString = '') {
    if (!this.accessKey || !this.secretKey) return {};
    const payload = { access_key: this.accessKey, nonce: crypto.randomUUID() };
    if (queryString) {
      const queryHash = crypto.createHash('sha512').update(queryString).digest('hex');
      payload.query_hash = queryHash;
      payload.query_hash_alg = 'SHA512';
    }
    // JWT signing would go here with jsonwebtoken library
    // For now, return headers structure
    return { Authorization: `Bearer ${Buffer.from(JSON.stringify(payload)).toString('base64')}` };
  }
}

// ═══════════════════════════════════════════════════════════════
// BINANCE CONNECTOR
// ═══════════════════════════════════════════════════════════════
class BinanceConnector {
  constructor(apiKey = '', apiSecret = '') {
    this.baseUrl = 'https://api.binance.com';
    this.apiKey = apiKey; this.apiSecret = apiSecret;
    this.rateLimit = { lastCall: 0, minInterval: 50 };
  }

  async _throttle() {
    const now = Date.now();
    const wait = this.rateLimit.minInterval - (now - this.rateLimit.lastCall);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    this.rateLimit.lastCall = Date.now();
  }

  _sign(params) {
    if (!this.apiSecret) return params;
    const qs = Object.entries(params).map(([k,v]) => `${k}=${v}`).join('&');
    const sig = crypto.createHmac('sha256', this.apiSecret).update(qs).digest('hex');
    return { ...params, signature: sig };
  }

  // --- Public APIs ---

  async getExchangeInfo() {
    await this._throttle();
    try {
      const data = await httpGet(`${this.baseUrl}/api/v3/exchangeInfo`);
      return (data.symbols || []).map(s => ({
        symbol: s.symbol, base: s.baseAsset, quote: s.quoteAsset,
        status: s.status
      }));
    } catch(e) { return []; }
  }

  async getTicker(symbol) {
    await this._throttle();
    const url = symbol
      ? `${this.baseUrl}/api/v3/ticker/24hr?symbol=${symbol}`
      : `${this.baseUrl}/api/v3/ticker/24hr`;
    try {
      const data = await httpGet(url);
      const fmt = t => ({
        symbol: t.symbol, price: parseFloat(t.lastPrice),
        open: parseFloat(t.openPrice), high: parseFloat(t.highPrice),
        low: parseFloat(t.lowPrice), volume: parseFloat(t.volume),
        quoteVolume: parseFloat(t.quoteVolume),
        changePercent: parseFloat(t.priceChangePercent),
        timestamp: t.closeTime
      });
      return Array.isArray(data) ? data.map(fmt) : [fmt(data)];
    } catch(e) { return []; }
  }

  async getKlines(symbol, interval = '1h', limit = 200) {
    await this._throttle();
    try {
      const data = await httpGet(`${this.baseUrl}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
      return Array.isArray(data) ? data.map(k => ({
        ts: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
        low: parseFloat(k[3]), close: parseFloat(k[4]),
        volume: parseFloat(k[5])
      })) : [];
    } catch(e) { return []; }
  }

  async getOrderbook(symbol, limit = 20) {
    await this._throttle();
    try {
      const data = await httpGet(`${this.baseUrl}/api/v3/depth?symbol=${symbol}&limit=${limit}`);
      return {
        symbol, lastUpdateId: data.lastUpdateId,
        asks: (data.asks || []).map(a => ({ price: parseFloat(a[0]), size: parseFloat(a[1]) })),
        bids: (data.bids || []).map(b => ({ price: parseFloat(b[0]), size: parseFloat(b[1]) }))
      };
    } catch(e) { return { symbol, asks: [], bids: [] }; }
  }

  async getRecentTrades(symbol, limit = 50) {
    await this._throttle();
    try {
      const data = await httpGet(`${this.baseUrl}/api/v3/trades?symbol=${symbol}&limit=${limit}`);
      return Array.isArray(data) ? data.map(t => ({
        id: t.id, price: parseFloat(t.price), qty: parseFloat(t.qty),
        time: t.time, isBuyerMaker: t.isBuyerMaker
      })) : [];
    } catch(e) { return []; }
  }
}

// ═══════════════════════════════════════════════════════════════
// UNIFIED DATA AGGREGATOR
// ═══════════════════════════════════════════════════════════════
class ExchangeAggregator {
  constructor() {
    this.upbit = new UpbitConnector();
    this.binance = new BinanceConnector();
    this.priceCache = {};
    this.candleCache = {};
    this.lastUpdate = 0;
  }

  async fetchAllPrices() {
    const results = { upbit: {}, binance: {}, ts: Date.now() };
    try {
      // Upbit 주요 마켓
      const upbitTickers = await this.upbit.getTicker('KRW-BTC,KRW-ETH,KRW-XRP,KRW-SOL,KRW-DOGE,KRW-ADA');
      for (const t of upbitTickers) {
        results.upbit[t.market] = t;
      }
    } catch(e) { /* skip */ }
    try {
      // Binance 주요 마켓
      const symbols = ['BTCUSDT','ETHUSDT','XRPUSDT','SOLUSDT','DOGEUSDT','ADAUSDT'];
      for (const sym of symbols) {
        const tickers = await this.binance.getTicker(sym);
        if (tickers[0]) results.binance[sym] = tickers[0];
      }
    } catch(e) { /* skip */ }
    this.priceCache = results;
    this.lastUpdate = Date.now();
    return results;
  }

  async fetchCandles(exchange, symbol, interval, count) {
    const key = `${exchange}:${symbol}:${interval}`;
    if (exchange === 'upbit') {
      const minuteMap = { '1m': 1, '5m': 5, '15m': 15, '1h': 60, '4h': 240 };
      const min = minuteMap[interval] || 60;
      const candles = await this.upbit.getCandles(symbol, 'minutes', count, min);
      this.candleCache[key] = candles;
      return candles;
    } else {
      const candles = await this.binance.getKlines(symbol, interval, count);
      this.candleCache[key] = candles;
      return candles;
    }
  }

  // 김치 프리미엄 계산
  calcKimchiPremium() {
    const btcUpbit = this.priceCache.upbit?.['KRW-BTC']?.price;
    const btcBinance = this.priceCache.binance?.['BTCUSDT']?.price;
    if (!btcUpbit || !btcBinance) return null;
    const usdkrw = btcUpbit / btcBinance;
    // 대략적 환율 (실시간이면 API로 가져와야 함)
    const officialRate = 1380; // 추정
    const premium = ((usdkrw / officialRate) - 1) * 100;
    return { usdkrw: usdkrw.toFixed(2), premium: premium.toFixed(2), btcKRW: btcUpbit, btcUSD: btcBinance };
  }
}

module.exports = { UpbitConnector, BinanceConnector, ExchangeAggregator };
