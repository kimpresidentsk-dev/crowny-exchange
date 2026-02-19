// ═══════════════════════════════════════════════════════════════
// Crowny MetaKernel Gateway — 미들웨어 통합 계층
// DEX ←→ AI ←→ Exchange 자동매매 파이프라인
// CTP 프로토콜 라우팅 + 이벤트 버스 + 리스크 관리
// ═══════════════════════════════════════════════════════════════

const EventEmitter = require('events');
const crypto = require('crypto');

class MetaKernelGateway extends EventEmitter {
  constructor({ db, dex, tradingAI, aggregator, tradeExecutor, apiKeyManager }) {
    super();
    this.db = db;
    this.dex = dex;
    this.tradingAI = tradingAI;
    this.aggregator = aggregator;
    this.tradeExecutor = tradeExecutor;
    this.apiKeyManager = apiKeyManager;

    // 서비스 레지스트리
    this.services = {
      dex: this.dex,
      ai: this.tradingAI,
      exchange: this.aggregator,
      executor: this.tradeExecutor
    };

    // 자동매매 활성 사용자
    this.autoTraders = new Map(); // userId → { intervalId, config }

    // Rate limiting
    this.rateLimits = new Map(); // userId → { count, resetAt }
    this.RATE_LIMIT = 100; // 분당 100요청
    this.RATE_WINDOW = 60000; // 1분

    // 이벤트 로그
    this.eventLog = [];

    // CTP 프로토콜 헤더
    this.ctpHeader = { protocol: 'CTP-T', version: '1.0', trit: '△○▽', engine: 'CrownyMetaKernel/1.0' };

    // 일일 리셋 (매일 자정)
    this._setupDailyReset();
  }

  // ═══════════════════════════════════
  // CTP 프로토콜 라우팅
  // ═══════════════════════════════════

  async route(service, action, params, user) {
    // Rate limit
    if (!this._checkRateLimit(user.id)) {
      throw new Error('RATE_LIMITED: 요청 빈도 초과 (분당 100회)');
    }

    // 로그
    this._logEvent('route', { service, action, userId: user.id });

    switch (service) {
      case 'dex': return this._routeDex(action, params, user);
      case 'ai': return this._routeAI(action, params, user);
      case 'exchange': return this._routeExchange(action, params, user);
      case 'auto': return this._routeAutoTrade(action, params, user);
      default: throw new Error(`Unknown service: ${service}`);
    }
  }

  // ─── DEX 라우팅 ───
  async _routeDex(action, params, user) {
    switch (action) {
      case 'swap': {
        // 잔액 확인 → 스왑 실행 → DB 기록
        const { poolId, tokenIn, amount } = params;
        const pool = this.dex.pools[poolId];
        if (!pool) throw new Error('풀을 찾을 수 없습니다');

        // DB에서 잔액 차감
        this.db.subtractBalance(user.id, tokenIn, amount);

        // 스왑 실행
        const result = this.dex.swap(user.id, poolId, tokenIn, parseInt(amount));

        // 받은 토큰 DB에 추가
        const tokenOut = tokenIn === pool.tokenA ? pool.tokenB : pool.tokenA;
        this.db.addBalance(user.id, tokenOut, result.amountOut);

        // 스왑 기록
        this.db.recordSwap({
          userId: user.id, poolId, tokenIn, tokenOut,
          amountIn: amount, amountOut: result.amountOut,
          fee: result.fee, slippage: result.slippage,
          priceImpact: result.priceImpact,
          tritState: result.slippage < 0.005 ? 'P' : result.slippage < 0.02 ? 'O' : 'T'
        });

        // 풀 상태 저장
        this.db.savePool(pool);

        // 이벤트 발행
        this.emit('swap', { userId: user.id, ...result });

        return { ctp: this.ctpHeader, success: true, result };
      }

      case 'addLiquidity': {
        const { poolId, amountA, amountB } = params;
        const pool = this.dex.pools[poolId];
        if (!pool) throw new Error('풀을 찾을 수 없습니다');

        this.db.subtractBalance(user.id, pool.tokenA, amountA);
        this.db.subtractBalance(user.id, pool.tokenB, amountB);

        const result = this.dex.addLiquidity(user.id, poolId, parseInt(amountA), parseInt(amountB));
        this.db.savePool(pool);

        this.emit('liquidity', { userId: user.id, ...result });
        return { ctp: this.ctpHeader, success: true, result };
      }

      case 'placeOrder': {
        const { poolId, side, price, amount } = params;
        const pool = this.dex.pools[poolId];
        if (!pool) throw new Error('풀을 찾을 수 없습니다');

        // 매수면 tokenB 잠금, 매도면 tokenA 잠금
        if (side === 'buy') {
          this.db.lockBalance(user.id, pool.tokenB, price * amount);
        } else {
          this.db.lockBalance(user.id, pool.tokenA, amount);
        }

        const order = this.dex.placeOrder(user.id, poolId, side, parseFloat(price), parseInt(amount));
        this.db.saveOrder({
          id: order.id, userId: user.id, poolId, side, price, amount,
          remaining: order.remaining, status: order.status, filled: 0
        });

        const matches = this.dex.matchOrders(poolId);
        this.emit('order', { userId: user.id, order, matches });

        return { ctp: this.ctpHeader, order, matches };
      }

      case 'balances': {
        return { ctp: this.ctpHeader, user: user.id, balances: this.db.getAllBalances(user.id) };
      }

      case 'pools': {
        const pools = Object.values(this.dex.pools).map(pool => ({
          id: pool.id, tokenA: pool.tokenA, tokenB: pool.tokenB,
          reserveA: pool.reserveA, reserveB: pool.reserveB,
          price: pool.priceAinB(), feeBps: pool.feeBps,
          swapCount: pool.swapCount, fees: pool.feesCollected,
          volume24h: pool.volume24h, lpShares: pool.totalLpShares,
          priceHistory: pool.priceHistory.slice(-100)
        }));
        return { ctp: this.ctpHeader, pools };
      }

      default: throw new Error(`Unknown DEX action: ${action}`);
    }
  }

  // ─── AI 라우팅 ───
  async _routeAI(action, params, user) {
    switch (action) {
      case 'analyze': {
        const { exchange = 'binance', symbol = 'BTCUSDT', interval = '1h' } = params;
        const candles = await this.aggregator.fetchCandles(exchange, symbol, interval, 200);
        if (!candles || candles.length < 50) {
          throw new Error('캔들 데이터 부족');
        }
        const result = this.tradingAI.analyze(candles, symbol);

        // DB 기록
        const signalId = this.db.saveAiSignal({
          symbol, exchange, interval,
          signal: result.consensus.signal,
          score: result.consensus.score,
          confidence: result.consensus.confidence,
          trit: result.consensus.signal === 'BUY' ? '△' : result.consensus.signal === 'SELL' ? '▽' : '○',
          strategies: result.strategies,
          risk: result.risk
        });

        // 자동매매 트리거
        this.emit('ai:signal', {
          signalId, userId: user.id, symbol, exchange, interval,
          ...result.consensus
        });

        return { ctp: this.ctpHeader, signalId, ...result };
      }

      case 'backtest': {
        const { exchange = 'binance', symbol = 'BTCUSDT', interval = '1h', balance = 10000000 } = params;
        const candles = await this.aggregator.fetchCandles(exchange, symbol, interval, 200);
        if (!candles || candles.length < 60) throw new Error('백테스트 데이터 부족');
        const result = this.tradingAI.runBacktest(candles, balance);
        return { ctp: this.ctpHeader, symbol, interval, ...result };
      }

      case 'multiAnalyze': {
        const symbols = params.symbols || ['BTCUSDT', 'ETHUSDT', 'XRPUSDT', 'SOLUSDT'];
        const results = [];
        for (const sym of symbols) {
          try {
            const candles = await this.aggregator.fetchCandles('binance', sym, '1h', 200);
            if (candles && candles.length >= 50) {
              results.push(this.tradingAI.analyze(candles, sym));
            }
          } catch (e) { /* skip */ }
        }
        return { ctp: this.ctpHeader, results };
      }

      case 'signals': {
        const { symbol = 'BTCUSDT', limit = 20 } = params;
        const signals = this.db.getRecentSignals(symbol, limit);
        return { ctp: this.ctpHeader, signals };
      }

      default: throw new Error(`Unknown AI action: ${action}`);
    }
  }

  // ─── 거래소 라우팅 ───
  async _routeExchange(action, params, user) {
    switch (action) {
      case 'placeOrder': {
        const { exchange, symbol, side, type, quantity, price } = params;
        const result = await this.tradeExecutor.executeOrder(
          user.id, exchange, symbol, side, type, quantity, price, 'manual'
        );
        this.emit('exchange:order', { userId: user.id, ...result });
        return { ctp: this.ctpHeader, ...result };
      }

      case 'cancelOrder': {
        const { exchange, symbol, exchangeOrderId } = params;
        const result = await this.tradeExecutor.cancelExchangeOrder(user.id, exchange, symbol, exchangeOrderId);
        return { ctp: this.ctpHeader, success: true, result };
      }

      case 'balance': {
        const { exchange } = params;
        const balance = await this.tradeExecutor.getExchangeBalance(user.id, exchange);
        return { ctp: this.ctpHeader, exchange, balance };
      }

      case 'openOrders': {
        const { exchange, symbol } = params;
        const orders = await this.tradeExecutor.getOpenExchangeOrders(user.id, exchange, symbol);
        return { ctp: this.ctpHeader, orders };
      }

      case 'history': {
        const orders = this.db.getUserExchangeOrders(user.id);
        return { ctp: this.ctpHeader, orders };
      }

      case 'prices': {
        const data = await this.aggregator.fetchAllPrices();
        const premium = this.aggregator.calcKimchiPremium();
        return { ctp: this.ctpHeader, ...data, kimchiPremium: premium };
      }

      default: throw new Error(`Unknown exchange action: ${action}`);
    }
  }

  // ─── 자동매매 라우팅 ───
  async _routeAutoTrade(action, params, user) {
    switch (action) {
      case 'enable': {
        const { exchange = 'binance', config = {} } = params;

        // API 키 확인
        const keys = this.apiKeyManager.get(user.id, exchange);
        if (!keys) throw new Error('API 키를 먼저 설정하세요');

        const autoConfig = {
          enabled: true,
          symbols: config.symbols || 'BTCUSDT,ETHUSDT',
          maxPositionPct: config.maxPositionPct || 0.1,
          stopLossPct: config.stopLossPct || 0.03,
          takeProfitPct: config.takeProfitPct || 0.06,
          minConfidence: config.minConfidence || 0.7,
          maxDailyTrades: config.maxDailyTrades || 10,
        };

        this.db.saveAutoTradeConfig(user.id, exchange, autoConfig);
        this._startAutoTrading(user.id, exchange);

        return { ctp: this.ctpHeader, success: true, config: autoConfig, status: 'enabled' };
      }

      case 'disable': {
        const { exchange = 'binance' } = params;
        this._stopAutoTrading(user.id, exchange);
        this.db.saveAutoTradeConfig(user.id, exchange, { ...this.db.getAutoTradeConfig(user.id, exchange), enabled: false });
        return { ctp: this.ctpHeader, success: true, status: 'disabled' };
      }

      case 'status': {
        const { exchange = 'binance' } = params;
        const config = this.db.getAutoTradeConfig(user.id, exchange);
        const isRunning = this.autoTraders.has(`${user.id}:${exchange}`);
        return { ctp: this.ctpHeader, config, running: isRunning };
      }

      case 'saveApiKeys': {
        const { exchange, accessKey, secretKey } = params;
        this.apiKeyManager.save(user.id, exchange, accessKey, secretKey);
        this.tradeExecutor.invalidateTrader(user.id, exchange);
        return { ctp: this.ctpHeader, success: true, message: `${exchange} API 키 저장 완료` };
      }

      case 'getApiKeys': {
        const { exchange } = params;
        const masked = this.apiKeyManager.getMasked(user.id, exchange);
        return { ctp: this.ctpHeader, keys: masked };
      }

      case 'deleteApiKeys': {
        const { exchange } = params;
        this.apiKeyManager.delete(user.id, exchange);
        this.tradeExecutor.invalidateTrader(user.id, exchange);
        this._stopAutoTrading(user.id, exchange);
        return { ctp: this.ctpHeader, success: true };
      }

      default: throw new Error(`Unknown auto-trade action: ${action}`);
    }
  }

  // ═══════════════════════════════════
  // 자동매매 파이프라인
  // ═══════════════════════════════════

  _startAutoTrading(userId, exchange) {
    const key = `${userId}:${exchange}`;
    if (this.autoTraders.has(key)) return; // 이미 실행 중

    const config = this.db.getAutoTradeConfig(userId, exchange);
    if (!config || !config.enabled) return;

    const symbols = (config.symbols || 'BTCUSDT').split(',');

    // 30초마다 분석 → 시그널 → 거래 파이프라인
    const intervalId = setInterval(async () => {
      try {
        for (const symbol of symbols) {
          await this._autoTradeCycle(userId, exchange, symbol, config);
        }
      } catch (e) {
        this._logEvent('auto_trade_error', { userId, exchange, error: e.message });
      }
    }, 30000);

    this.autoTraders.set(key, { intervalId, config });
    this._logEvent('auto_trade_start', { userId, exchange, symbols });
    this.emit('auto:started', { userId, exchange });
  }

  _stopAutoTrading(userId, exchange) {
    const key = `${userId}:${exchange}`;
    const trader = this.autoTraders.get(key);
    if (trader) {
      clearInterval(trader.intervalId);
      this.autoTraders.delete(key);
      this._logEvent('auto_trade_stop', { userId, exchange });
      this.emit('auto:stopped', { userId, exchange });
    }
  }

  async _autoTradeCycle(userId, exchange, symbol, config) {
    // 1. 캔들 데이터 가져오기
    const candles = await this.aggregator.fetchCandles(exchange, symbol, '1h', 200);
    if (!candles || candles.length < 50) return;

    // 2. AI 분석
    const analysis = this.tradingAI.analyze(candles, symbol);
    const { signal, score, confidence } = analysis.consensus;

    // 3. 신뢰도 필터
    if (confidence < config.min_confidence) {
      this._logEvent('auto_trade_skip', { userId, symbol, reason: `신뢰도 부족 (${(confidence * 100).toFixed(0)}% < ${(config.min_confidence * 100).toFixed(0)}%)` });
      return;
    }

    // 4. HOLD이면 스킵
    if (signal === 'HOLD') return;

    // 5. 리스크 체크
    if (!analysis.risk?.allowed) {
      this._logEvent('auto_trade_blocked', { userId, symbol, reason: '리스크 체크 차단' });
      return;
    }

    // 6. 일일 한도 체크
    const currentConfig = this.db.getAutoTradeConfig(userId, exchange);
    if (currentConfig.daily_trades_used >= currentConfig.max_daily_trades) {
      this._logEvent('auto_trade_limit', { userId, symbol, reason: '일일 한도 초과' });
      return;
    }

    // 7. 연속 손실 체크
    if (currentConfig.consecutive_losses >= currentConfig.max_consecutive_losses) {
      this._logEvent('auto_trade_paused', { userId, symbol, reason: `연속 ${currentConfig.consecutive_losses}회 손실` });
      return;
    }

    // 8. 주문 수량 계산
    const side = signal === 'BUY' ? 'buy' : 'sell';
    const quantity = this._calculateQuantity(userId, exchange, symbol, side, config);
    if (!quantity || quantity <= 0) return;

    // 9. DB에 시그널 기록
    const signalId = this.db.saveAiSignal({
      symbol, exchange, interval: '1h',
      signal, score, confidence,
      trit: signal === 'BUY' ? '△' : '▽',
      strategies: analysis.strategies,
      risk: analysis.risk
    });

    // 10. 주문 실행
    try {
      const result = await this.tradeExecutor.executeOrder(
        userId, exchange, symbol, side, 'market', quantity, null, 'auto', signalId
      );

      this._logEvent('auto_trade_executed', {
        userId, symbol, side, quantity, signalId,
        score: score.toFixed(3), confidence: (confidence * 100).toFixed(0) + '%'
      });

      this.emit('auto:trade', { userId, exchange, symbol, side, quantity, result });

    } catch (e) {
      this._logEvent('auto_trade_failed', { userId, symbol, error: e.message });
      this.emit('auto:error', { userId, exchange, symbol, error: e.message });
    }
  }

  _calculateQuantity(userId, exchange, symbol, side, config) {
    // 간단한 포지션 크기 계산
    // 실제로는 현재 가격, 잔고 기반으로 정밀 계산 필요
    try {
      const balances = this.db.getAllBalances(userId);
      const usdtBalance = balances['USDT']?.balance || 0;
      const maxOrderValue = usdtBalance * config.max_position_pct;

      // 대략적 수량 (실제로는 현재 시장가 기반)
      if (side === 'buy') {
        // USDT로 얼마 매수할지
        return Math.floor(maxOrderValue * 100) / 100; // 소수 2자리
      } else {
        // 보유 토큰 일부 매도
        const tokenSymbol = symbol.replace('USDT', '').replace('KRW-', '');
        const tokenBalance = balances[tokenSymbol]?.balance || 0;
        return Math.floor(tokenBalance * config.max_position_pct * 1000) / 1000;
      }
    } catch (e) {
      return 0;
    }
  }

  // ═══════════════════════════════════
  // Rate Limiting
  // ═══════════════════════════════════

  _checkRateLimit(userId) {
    const now = Date.now();
    let limit = this.rateLimits.get(userId);

    if (!limit || now > limit.resetAt) {
      limit = { count: 0, resetAt: now + this.RATE_WINDOW };
      this.rateLimits.set(userId, limit);
    }

    limit.count++;
    return limit.count <= this.RATE_LIMIT;
  }

  // ═══════════════════════════════════
  // 이벤트 & 로그
  // ═══════════════════════════════════

  _logEvent(type, data) {
    const event = { type, data, timestamp: new Date().toISOString() };
    this.eventLog.push(event);
    if (this.eventLog.length > 1000) this.eventLog.shift();
    // console.log(`[MetaKernel] ${type}:`, JSON.stringify(data).slice(0, 200));
  }

  getEventLog(limit = 50) {
    return this.eventLog.slice(-limit);
  }

  _setupDailyReset() {
    // 매일 자정에 일일 거래 카운트 리셋
    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    const msUntilMidnight = midnight - now;

    setTimeout(() => {
      this.db.resetDailyTrades();
      this._logEvent('daily_reset', { message: '일일 거래 카운트 리셋' });
      // 이후 24시간마다 반복
      setInterval(() => {
        this.db.resetDailyTrades();
        this._logEvent('daily_reset', { message: '일일 거래 카운트 리셋' });
      }, 24 * 60 * 60 * 1000);
    }, msUntilMidnight);
  }

  // ═══════════════════════════════════
  // 상태 요약
  // ═══════════════════════════════════

  getStatus() {
    return {
      ctp: this.ctpHeader,
      services: {
        dex: { pools: Object.keys(this.dex.pools).length, tokens: Object.keys(this.dex.tokens).length },
        ai: { strategies: 6, consensus: '3-Trit' },
        exchange: { connectors: ['upbit', 'binance'] }
      },
      autoTraders: this.autoTraders.size,
      rateLimit: { limit: this.RATE_LIMIT, window: this.RATE_WINDOW + 'ms' },
      eventLogSize: this.eventLog.length,
      uptime: process.uptime()
    };
  }
}

module.exports = { MetaKernelGateway };
