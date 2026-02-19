// ═══════════════════════════════════════════════════════════════
// Crowny Exchange — Private API Trade Executor
// Upbit/Binance 실제 주문 실행 + 안전장치
// ═══════════════════════════════════════════════════════════════

const https = require('https');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const querystring = require('querystring');

// ─── HTTP Helper ───
function httpsRequest(method, url, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'CrownyTrader/1.0', ...headers }
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(data) }); } catch(e) { resolve({ status: res.statusCode, data }); } });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timeout')); });
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════
// UPBIT PRIVATE API
// ═══════════════════════════════════════════════════════════════
class UpbitTrader {
  constructor(accessKey, secretKey) {
    this.accessKey = accessKey;
    this.secretKey = secretKey;
    this.baseUrl = 'https://api.upbit.com/v1';
  }

  _createToken(params = null) {
    const payload = {
      access_key: this.accessKey,
      nonce: uuidv4(),
    };
    if (params) {
      const query = querystring.encode(params);
      const hash = crypto.createHash('sha512').update(query, 'utf-8').digest('hex');
      payload.query_hash = hash;
      payload.query_hash_alg = 'SHA512';
    }
    return jwt.sign(payload, this.secretKey);
  }

  // 잔고 조회
  async getAccounts() {
    const token = this._createToken();
    const result = await httpsRequest('GET', `${this.baseUrl}/accounts`, null, {
      Authorization: `Bearer ${token}`
    });
    if (result.status !== 200) throw new Error(`Upbit 잔고 조회 실패: ${JSON.stringify(result.data)}`);
    return result.data;
  }

  // 주문 실행
  async placeOrder(market, side, volume, price = null, ordType = 'limit') {
    const params = {
      market,
      side, // bid(매수) | ask(매도)
      ord_type: ordType, // limit | price(시장가매수) | market(시장가매도)
    };
    if (ordType === 'limit') {
      params.price = String(price);
      params.volume = String(volume);
    } else if (ordType === 'price') {
      // 시장가 매수: price = 총 매수 금액
      params.price = String(price || volume);
    } else if (ordType === 'market') {
      // 시장가 매도: volume = 매도 수량
      params.volume = String(volume);
    }

    const token = this._createToken(params);
    const result = await httpsRequest('POST', `${this.baseUrl}/orders`, params, {
      Authorization: `Bearer ${token}`
    });
    if (result.status !== 201 && result.status !== 200) {
      throw new Error(`Upbit 주문 실패: ${JSON.stringify(result.data)}`);
    }
    return result.data;
  }

  // 주문 취소
  async cancelOrder(uuid) {
    const params = { uuid };
    const token = this._createToken(params);
    const result = await httpsRequest('DELETE', `${this.baseUrl}/order?uuid=${uuid}`, null, {
      Authorization: `Bearer ${token}`
    });
    return result.data;
  }

  // 주문 조회
  async getOrder(uuid) {
    const params = { uuid };
    const token = this._createToken(params);
    const result = await httpsRequest('GET', `${this.baseUrl}/order?uuid=${uuid}`, null, {
      Authorization: `Bearer ${token}`
    });
    return result.data;
  }

  // 대기 주문 목록
  async getOpenOrders(market) {
    const params = { market, state: 'wait' };
    const token = this._createToken(params);
    const qs = querystring.encode(params);
    const result = await httpsRequest('GET', `${this.baseUrl}/orders?${qs}`, null, {
      Authorization: `Bearer ${token}`
    });
    return result.data;
  }
}

// ═══════════════════════════════════════════════════════════════
// BINANCE PRIVATE API
// ═══════════════════════════════════════════════════════════════
class BinanceTrader {
  constructor(apiKey, secretKey) {
    this.apiKey = apiKey;
    this.secretKey = secretKey;
    this.baseUrl = 'https://api.binance.com';
  }

  _sign(params) {
    params.timestamp = Date.now();
    const query = new URLSearchParams(params).toString();
    const signature = crypto.createHmac('sha256', this.secretKey).update(query).digest('hex');
    return query + '&signature=' + signature;
  }

  // 잔고 조회
  async getAccount() {
    const qs = this._sign({});
    const result = await httpsRequest('GET', `${this.baseUrl}/api/v3/account?${qs}`, null, {
      'X-MBX-APIKEY': this.apiKey
    });
    if (result.status !== 200) throw new Error(`Binance 잔고 조회 실패: ${JSON.stringify(result.data)}`);
    return result.data;
  }

  // 주문 실행
  async placeOrder(symbol, side, quantity, price = null, type = 'LIMIT') {
    const params = {
      symbol,
      side: side.toUpperCase(), // BUY | SELL
      type: type.toUpperCase(),
      quantity: String(quantity),
    };

    if (type.toUpperCase() === 'LIMIT') {
      params.timeInForce = 'GTC';
      params.price = String(price);
    }

    const qs = this._sign(params);
    const result = await httpsRequest('POST', `${this.baseUrl}/api/v3/order?${qs}`, null, {
      'X-MBX-APIKEY': this.apiKey
    });
    if (result.status !== 200) {
      throw new Error(`Binance 주문 실패: ${JSON.stringify(result.data)}`);
    }
    return result.data;
  }

  // 주문 취소
  async cancelOrder(symbol, orderId) {
    const qs = this._sign({ symbol, orderId: String(orderId) });
    const result = await httpsRequest('DELETE', `${this.baseUrl}/api/v3/order?${qs}`, null, {
      'X-MBX-APIKEY': this.apiKey
    });
    return result.data;
  }

  // 주문 조회
  async getOrder(symbol, orderId) {
    const qs = this._sign({ symbol, orderId: String(orderId) });
    const result = await httpsRequest('GET', `${this.baseUrl}/api/v3/order?${qs}`, null, {
      'X-MBX-APIKEY': this.apiKey
    });
    return result.data;
  }

  // 미체결 주문
  async getOpenOrders(symbol) {
    const qs = this._sign({ symbol });
    const result = await httpsRequest('GET', `${this.baseUrl}/api/v3/openOrders?${qs}`, null, {
      'X-MBX-APIKEY': this.apiKey
    });
    return result.data;
  }
}

// ═══════════════════════════════════════════════════════════════
// TRADE EXECUTOR — 안전장치 포함 실행 엔진
// ═══════════════════════════════════════════════════════════════
class TradeExecutor {
  constructor(db, apiKeyManager) {
    this.db = db;
    this.apiKeyManager = apiKeyManager;
    this.activeTraders = new Map(); // userId:exchange → trader instance
  }

  // Trader 인스턴스 생성/캐시
  _getTrader(userId, exchange) {
    const key = `${userId}:${exchange}`;
    if (this.activeTraders.has(key)) return this.activeTraders.get(key);

    const keys = this.apiKeyManager.get(userId, exchange);
    if (!keys) throw new Error(`${exchange} API 키가 설정되지 않았습니다`);

    let trader;
    if (exchange === 'upbit') {
      trader = new UpbitTrader(keys.accessKey, keys.secretKey);
    } else if (exchange === 'binance') {
      trader = new BinanceTrader(keys.accessKey, keys.secretKey);
    } else {
      throw new Error(`지원하지 않는 거래소: ${exchange}`);
    }

    this.activeTraders.set(key, trader);
    return trader;
  }

  // 캐시 무효화 (API 키 변경 시)
  invalidateTrader(userId, exchange) {
    this.activeTraders.delete(`${userId}:${exchange}`);
  }

  // ─── 안전장치 체크 ───
  _checkSafety(userId, exchange, side, quantity, price) {
    const config = this.db.getAutoTradeConfig(userId, exchange);
    const errors = [];

    if (config) {
      // 일일 거래 횟수
      if (config.daily_trades_used >= config.max_daily_trades) {
        errors.push(`일일 거래 한도 초과 (${config.daily_trades_used}/${config.max_daily_trades})`);
      }

      // 연속 손실
      if (config.consecutive_losses >= config.max_consecutive_losses) {
        errors.push(`연속 손실 한도 도달 (${config.consecutive_losses}회) — 자동매매 일시 정지`);
      }

      // 포지션 크기
      const balances = this.db.getAllBalances(userId);
      const totalValue = Object.values(balances).reduce((sum, b) => sum + b.balance, 0);
      const orderValue = quantity * (price || 1);
      if (totalValue > 0 && orderValue / totalValue > config.max_position_pct) {
        errors.push(`포지션 크기 초과 (${(orderValue / totalValue * 100).toFixed(1)}% > ${(config.max_position_pct * 100).toFixed(0)}%)`);
      }
    }

    return { safe: errors.length === 0, errors };
  }

  // ─── 주문 실행 (통합) ───
  async executeOrder(userId, exchange, symbol, side, type, quantity, price = null, source = 'manual', aiSignalId = null) {
    // 1. 안전장치 체크
    const safety = this._checkSafety(userId, exchange, side, quantity, price);
    if (!safety.safe) {
      throw new Error(`안전장치 차단: ${safety.errors.join(', ')}`);
    }

    // 2. DB에 주문 기록 (pending)
    const orderId = this.db.saveExchangeOrder({
      userId, exchange, symbol, side, type, price, quantity,
      status: 'pending', source, aiSignalId
    });

    try {
      // 3. 거래소 API 호출
      const trader = this._getTrader(userId, exchange);
      let result;

      if (exchange === 'upbit') {
        const market = symbol; // 예: KRW-BTC
        const upbitSide = side === 'buy' ? 'bid' : 'ask';
        const ordType = type === 'market' ? (side === 'buy' ? 'price' : 'market') : 'limit';
        result = await trader.placeOrder(market, upbitSide, quantity, price, ordType);
      } else if (exchange === 'binance') {
        result = await trader.placeOrder(symbol, side, quantity, price, type);
      }

      // 4. DB 업데이트 (성공)
      this.db.updateExchangeOrder(orderId, {
        status: result.status || 'submitted',
        exchangeOrderId: result.uuid || result.orderId || result.clientOrderId || '',
        filledQty: parseFloat(result.executedQty || result.executed_volume || 0),
        filledPrice: parseFloat(result.price || result.avg_price || price || 0),
      });

      // 5. 일일 거래 카운트 증가
      this.db.incrementDailyTrades(userId, exchange);

      return {
        success: true,
        orderId,
        exchangeResult: result,
        exchange,
        symbol,
        side,
        type,
        quantity,
        price
      };

    } catch (error) {
      // DB 업데이트 (실패)
      this.db.updateExchangeOrder(orderId, {
        status: 'failed',
        error: error.message.slice(0, 500)
      });
      throw error;
    }
  }

  // ─── 잔고 조회 (거래소) ───
  async getExchangeBalance(userId, exchange) {
    const trader = this._getTrader(userId, exchange);
    if (exchange === 'upbit') {
      return await trader.getAccounts();
    } else if (exchange === 'binance') {
      const account = await trader.getAccount();
      return account.balances?.filter(b => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0) || [];
    }
  }

  // ─── 주문 취소 ───
  async cancelExchangeOrder(userId, exchange, symbol, exchangeOrderId) {
    const trader = this._getTrader(userId, exchange);
    if (exchange === 'upbit') {
      return await trader.cancelOrder(exchangeOrderId);
    } else if (exchange === 'binance') {
      return await trader.cancelOrder(symbol, exchangeOrderId);
    }
  }

  // ─── 미체결 주문 ───
  async getOpenExchangeOrders(userId, exchange, symbol) {
    const trader = this._getTrader(userId, exchange);
    if (exchange === 'upbit') {
      return await trader.getOpenOrders(symbol);
    } else {
      return await trader.getOpenOrders(symbol);
    }
  }

  // ─── 거래 결과 추적 (손익 기록) ───
  recordTradeResult(userId, exchange, isProfit) {
    if (isProfit) {
      this.db.resetConsecutiveLosses(userId, exchange);
    } else {
      this.db.incrementConsecutiveLosses(userId, exchange);
    }
  }
}

module.exports = { UpbitTrader, BinanceTrader, TradeExecutor };
