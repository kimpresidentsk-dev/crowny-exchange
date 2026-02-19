// Crowny Exchange Platform — Production Server v2.0
// MetaKernel Gateway + DB + Auth + Real Trading + CTP-T

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { CrownyDEX } = require('../lib/dex-engine');
const { ExchangeAggregator } = require('../lib/exchange-api');
const { TradingAI } = require('../lib/trading-ai');
const { CrownyDB } = require('../lib/db');
const { AuthManager, ApiKeyManager } = require('../lib/auth');
const { TradeExecutor } = require('../lib/trade-executor');
const { MetaKernelGateway } = require('../lib/gateway');

const PORT = process.env.PORT || 7400;

// ═══ Initialize All Services ═══
const db = new CrownyDB();
const auth = new AuthManager(db);
const apiKeyManager = new ApiKeyManager(db);
const dex = new CrownyDEX();
const aggregator = new ExchangeAggregator();
const tradingAI = new TradingAI({ risk: { maxPositionSize: 0.1, stopLoss: 0.03, takeProfit: 0.06 } });
const tradeExecutor = new TradeExecutor(db, apiKeyManager);
const gateway = new MetaKernelGateway({ db, dex, tradingAI, aggregator, tradeExecutor, apiKeyManager });

// ═══ HTTP Server ═══
const mimeTypes = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml'
};

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { resolve({}); } });
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
  });
  res.end(JSON.stringify(data));
}

const ctpH = { protocol: 'CTP-T', version: '2.0', trit: '△○▽', engine: 'CrownyExchange/2.0' };

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' });
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  try {
    // ═══ AUTH (No login needed) ═══
    if (p === '/api/auth/register' && req.method === 'POST') {
      const b = await parseBody(req);
      const r = await auth.register(b.email, b.username, b.password);
      return json(res, { ctp: ctpH, success: true, ...r });
    }
    if (p === '/api/auth/login' && req.method === 'POST') {
      const b = await parseBody(req);
      const r = await auth.login(b.email || b.username, b.password);
      return json(res, { ctp: ctpH, success: true, ...r });
    }
    if (p === '/api/status') return json(res, { ctp: ctpH, ...gateway.getStatus() });

    // ═══ PUBLIC READ APIs ═══
    if (p === '/api/dex/summary') return json(res, { ctp: ctpH, ...dex.summary() });
    if (p === '/api/dex/pools') {
      const pools = Object.values(dex.pools).map(pool => ({
        id: pool.id, tokenA: pool.tokenA, tokenB: pool.tokenB,
        reserveA: pool.reserveA, reserveB: pool.reserveB,
        price: pool.priceAinB(), feeBps: pool.feeBps,
        swapCount: pool.swapCount, fees: pool.feesCollected,
        volume24h: pool.volume24h, lpShares: pool.totalLpShares,
        priceHistory: pool.priceHistory.slice(-100)
      }));
      return json(res, { ctp: ctpH, pools });
    }
    if (p === '/api/dex/tokens') return json(res, { ctp: ctpH, tokens: Object.values(dex.tokens) });
    if (p === '/api/dex/orderbook') {
      const poolId = url.searchParams.get('pool') || 'CRWN-USDT';
      return json(res, { ctp: ctpH, poolId, orders: dex.orderBook.openOrders(poolId) });
    }
    if (p === '/api/dex/history') {
      return json(res, { ctp: ctpH, swaps: dex.swapHistory.slice(-parseInt(url.searchParams.get('limit') || '50')) });
    }
    if (p === '/api/market/prices') {
      const data = await aggregator.fetchAllPrices();
      return json(res, { ctp: ctpH, ...data, kimchiPremium: aggregator.calcKimchiPremium() });
    }
    if (p === '/api/market/candles') {
      const candles = await aggregator.fetchCandles(
        url.searchParams.get('exchange') || 'binance',
        url.searchParams.get('symbol') || 'BTCUSDT',
        url.searchParams.get('interval') || '1h',
        parseInt(url.searchParams.get('count') || '200')
      );
      return json(res, { ctp: ctpH, candles });
    }
    if (p === '/api/market/orderbook') {
      const exch = url.searchParams.get('exchange') || 'binance';
      const sym = url.searchParams.get('symbol') || 'BTCUSDT';
      const data = exch === 'upbit' ? await aggregator.upbit.getOrderbook(sym) : await aggregator.binance.getOrderbook(sym);
      return json(res, { ctp: ctpH, exchange: exch, data });
    }
    if (p === '/api/ai/analyze') {
      const candles = await aggregator.fetchCandles(url.searchParams.get('exchange') || 'binance', url.searchParams.get('symbol') || 'BTCUSDT', url.searchParams.get('interval') || '1h', 200);
      if (!candles || candles.length < 50) return json(res, { ctp: ctpH, error: '캔들 데이터 부족' });
      return json(res, { ctp: ctpH, ...tradingAI.analyze(candles, url.searchParams.get('symbol') || 'BTCUSDT') });
    }
    if (p === '/api/ai/backtest') {
      const candles = await aggregator.fetchCandles(url.searchParams.get('exchange') || 'binance', url.searchParams.get('symbol') || 'BTCUSDT', url.searchParams.get('interval') || '1h', 200);
      if (!candles || candles.length < 60) return json(res, { ctp: ctpH, error: '백테스트 데이터 부족' });
      return json(res, { ctp: ctpH, ...tradingAI.runBacktest(candles, parseInt(url.searchParams.get('balance') || '10000000')) });
    }
    if (p === '/api/ai/multi-analyze') {
      const symbols = (url.searchParams.get('symbols') || 'BTCUSDT,ETHUSDT,XRPUSDT,SOLUSDT').split(',');
      const results = [];
      for (const sym of symbols) {
        const c = await aggregator.fetchCandles('binance', sym, '1h', 200);
        if (c && c.length >= 50) results.push(tradingAI.analyze(c, sym));
      }
      return json(res, { ctp: ctpH, results });
    }

    // ═══ AUTHENTICATED APIs ═══
    const user = auth.authenticate(req);

    if (p === '/api/auth/me') {
      if (!user) return json(res, { error: '인증 필요' }, 401);
      return json(res, { ctp: ctpH, user: db.getUserById(user.id) });
    }
    if (p === '/api/auth/change-password' && req.method === 'POST') {
      if (!user) return json(res, { error: '인증 필요' }, 401);
      const b = await parseBody(req);
      await auth.changePassword(user.id, b.currentPassword, b.newPassword);
      return json(res, { ctp: ctpH, success: true });
    }

    // ─── DEX (Authenticated) ───
    if (p === '/api/dex/balances') {
      if (!user) return json(res, { error: '인증 필요' }, 401);
      const balances = db.getAllBalances(user.id);
      const available = {};
      for (const [token, bal] of Object.entries(balances)) available[token] = bal.balance - bal.locked;
      return json(res, { ctp: ctpH, user: user.id, balances: available, raw: balances });
    }
    if (p === '/api/dex/swap' && req.method === 'POST') {
      if (!user) return json(res, { error: '인증 필요' }, 401);
      const b = await parseBody(req);
      const r = await gateway.route('dex', 'swap', { poolId: b.poolId, tokenIn: b.tokenIn, amount: parseInt(b.amount) }, user);
      broadcast({ type: 'swap', data: r.result });
      return json(res, r);
    }
    if (p === '/api/dex/liquidity' && req.method === 'POST') {
      if (!user) return json(res, { error: '인증 필요' }, 401);
      const b = await parseBody(req);
      const r = await gateway.route('dex', 'addLiquidity', { poolId: b.poolId, amountA: parseInt(b.amountA), amountB: parseInt(b.amountB) }, user);
      broadcast({ type: 'liquidity', data: r.result });
      return json(res, r);
    }
    if (p === '/api/dex/order' && req.method === 'POST') {
      if (!user) return json(res, { error: '인증 필요' }, 401);
      const b = await parseBody(req);
      const r = await gateway.route('dex', 'placeOrder', { poolId: b.poolId, side: b.side, price: parseFloat(b.price), amount: parseInt(b.amount) }, user);
      broadcast({ type: 'order', data: r });
      return json(res, r);
    }

    // ─── Exchange Trading (Authenticated) ───
    if (p === '/api/exchange/order' && req.method === 'POST') {
      if (!user) return json(res, { error: '인증 필요' }, 401);
      return json(res, await gateway.route('exchange', 'placeOrder', await parseBody(req), user));
    }
    if (p === '/api/exchange/cancel' && req.method === 'POST') {
      if (!user) return json(res, { error: '인증 필요' }, 401);
      return json(res, await gateway.route('exchange', 'cancelOrder', await parseBody(req), user));
    }
    if (p === '/api/exchange/balance') {
      if (!user) return json(res, { error: '인증 필요' }, 401);
      return json(res, await gateway.route('exchange', 'balance', { exchange: url.searchParams.get('exchange') || 'binance' }, user));
    }
    if (p === '/api/exchange/orders') {
      if (!user) return json(res, { error: '인증 필요' }, 401);
      return json(res, await gateway.route('exchange', 'history', {}, user));
    }

    // ─── API Key Management (Authenticated) ───
    if (p === '/api/settings/api-keys' && req.method === 'POST') {
      if (!user) return json(res, { error: '인증 필요' }, 401);
      return json(res, await gateway.route('auto', 'saveApiKeys', await parseBody(req), user));
    }
    if (p === '/api/settings/api-keys' && req.method === 'GET') {
      if (!user) return json(res, { error: '인증 필요' }, 401);
      return json(res, await gateway.route('auto', 'getApiKeys', { exchange: url.searchParams.get('exchange') || 'binance' }, user));
    }
    if (p === '/api/settings/api-keys' && req.method === 'DELETE') {
      if (!user) return json(res, { error: '인증 필요' }, 401);
      return json(res, await gateway.route('auto', 'deleteApiKeys', await parseBody(req), user));
    }

    // ─── Auto-trade (Authenticated) ───
    if (p === '/api/auto/enable' && req.method === 'POST') {
      if (!user) return json(res, { error: '인증 필요' }, 401);
      return json(res, await gateway.route('auto', 'enable', await parseBody(req), user));
    }
    if (p === '/api/auto/disable' && req.method === 'POST') {
      if (!user) return json(res, { error: '인증 필요' }, 401);
      return json(res, await gateway.route('auto', 'disable', await parseBody(req), user));
    }
    if (p === '/api/auto/status') {
      if (!user) return json(res, { error: '인증 필요' }, 401);
      return json(res, await gateway.route('auto', 'status', { exchange: url.searchParams.get('exchange') || 'binance' }, user));
    }
    if (p === '/api/events') {
      if (!user) return json(res, { error: '인증 필요' }, 401);
      return json(res, { ctp: ctpH, events: gateway.getEventLog(parseInt(url.searchParams.get('limit') || '50')) });
    }

    // ═══ STATIC FILES ═══
    let fileP = p;
    if (p === '/') fileP = '/index.html';
    else if (p === '/dex') fileP = '/dex.html';
    else if (p === '/ai') fileP = '/ai.html';
    else if (p === '/login') fileP = '/login.html';

    let filePath = path.join(__dirname, '..', 'public', fileP);
    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
      return fs.createReadStream(filePath).pipe(res);
    }

    json(res, { error: 'Not Found', path: p }, 404);
  } catch (err) {
    console.error(`[ERROR] ${p}:`, err.message);
    const status = err.message.includes('인증') ? 401 : err.message.includes('RATE') ? 429 : 400;
    json(res, { error: err.message }, status);
  }
});

// ═══ WebSocket ═══
const wss = new WebSocketServer({ server });
const clients = new Set();

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const ws of clients) if (ws.readyState === 1) ws.send(msg);
}
function broadcastToUser(userId, data) {
  const msg = JSON.stringify(data);
  for (const ws of clients) if (ws.readyState === 1 && ws._userId === userId) ws.send(msg);
}

wss.on('connection', (ws, req) => {
  clients.add(ws);
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const token = url.searchParams.get('token');
  if (token) {
    const decoded = auth.verifyToken(token);
    if (decoded) { ws._userId = decoded.userId; ws._username = decoded.username; }
  }
  ws.send(JSON.stringify({ type: 'connected', msg: 'CrownyExchange v2.0 △○▽', authenticated: !!ws._userId }));
  ws.on('close', () => { clients.delete(ws); if (ws._priceInterval) clearInterval(ws._priceInterval); });
  ws.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'auth') {
        const d = auth.verifyToken(data.token);
        if (d) { ws._userId = d.userId; ws._username = d.username; ws.send(JSON.stringify({ type: 'authenticated', user: d.username })); }
      }
      if (data.type === 'subscribe_prices') {
        const iv = setInterval(async () => {
          if (ws.readyState !== 1) { clearInterval(iv); return; }
          try {
            const prices = await aggregator.fetchAllPrices();
            ws.send(JSON.stringify({ type: 'prices', data: { ...prices, kimchiPremium: aggregator.calcKimchiPremium() } }));
          } catch(e) {}
        }, 5000);
        ws._priceInterval = iv;
      }
      if (data.type === 'analyze' && ws._userId) {
        const c = await aggregator.fetchCandles(data.exchange || 'binance', data.symbol || 'BTCUSDT', data.interval || '1h', 200);
        if (c && c.length >= 50) ws.send(JSON.stringify({ type: 'analysis', data: tradingAI.analyze(c, data.symbol) }));
      }
    } catch(e) {}
  });
});

// Gateway events → WebSocket
gateway.on('swap', d => broadcast({ type: 'swap', data: d }));
gateway.on('order', d => broadcast({ type: 'order', data: d }));
gateway.on('exchange:order', d => broadcastToUser(d.userId, { type: 'exchange_order', data: d }));
gateway.on('auto:trade', d => broadcastToUser(d.userId, { type: 'auto_trade', data: d }));
gateway.on('auto:error', d => broadcastToUser(d.userId, { type: 'auto_error', data: d }));

// DEX price ticker
setInterval(() => {
  for (const pool of Object.values(dex.pools)) {
    if (pool.reserveA > 100 && pool.reserveB > 100) {
      const amt = Math.floor(pool.reserveA * 0.0001 * Math.random());
      if (amt > 0) try { if (Math.random() > 0.5) pool.swapAtoB(amt); else pool.swapBtoA(Math.floor(amt * pool.priceAinB())); } catch(e) {}
    }
  }
  broadcast({ type: 'dex_update', data: Object.values(dex.pools).map(p => ({ id: p.id, price: p.priceAinB(), reserveA: p.reserveA, reserveB: p.reserveB, swaps: p.swapCount, volume: p.volume24h })) });
}, 5000);

// ═══ Start ═══
server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║  Crowny Exchange Platform v2.0 (Production)                   ║
║  MetaKernel Gateway + DB + Auth + Real Trading                ║
║  Protocol: CTP-T △○▽                                         ║
╠═══════════════════════════════════════════════════════════════╣
║  HTTP:      http://localhost:${PORT}                              ║
║  WS:        ws://localhost:${PORT}                                ║
║  DEX GUI:   http://localhost:${PORT}/dex                          ║
║  AI GUI:    http://localhost:${PORT}/ai                           ║
║  Login:     http://localhost:${PORT}/login                        ║
╠═══════════════════════════════════════════════════════════════╣
║  DB:     SQLite (data/crowny.db)                              ║
║  Auth:   JWT + bcrypt (24h)                                   ║
║  Crypto: AES-256-GCM                                         ║
╠═══════════════════════════════════════════════════════════════╣
║  DEX:    ${Object.keys(dex.pools).length} pools · ${Object.keys(dex.tokens).length} tokens                                   ║
║  AI:     6 strategies · 3-Trit consensus                      ║
║  APIs:   Upbit + Binance (Private + Public)                   ║
║  Safety: Rate limit · Position cap · Loss limit               ║
╚═══════════════════════════════════════════════════════════════╝
  `);
});

process.on('SIGINT', () => { for (const pool of Object.values(dex.pools)) try { db.savePool(pool); } catch(e) {} db.close(); process.exit(0); });
process.on('SIGTERM', () => { for (const pool of Object.values(dex.pools)) try { db.savePool(pool); } catch(e) {} db.close(); process.exit(0); });
