// ═══════════════════════════════════════════════════════════════
// Crowny Exchange — Database Layer (SQLite)
// 영속 저장: 유저, 지갑, 풀, 주문, 거래, API키, AI시그널
// ═══════════════════════════════════════════════════════════════

const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'crowny.db');

class CrownyDB {
  constructor(dbPath = DB_PATH) {
    const fs = require('fs');
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this._init();
  }

  _init() {
    this.db.exec(`
      -- 사용자
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT DEFAULT 'user',
        created_at TEXT DEFAULT (datetime('now')),
        last_login TEXT
      );

      -- 지갑 잔액
      CREATE TABLE IF NOT EXISTS wallets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        token TEXT NOT NULL,
        balance REAL DEFAULT 0,
        locked REAL DEFAULT 0,
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id),
        UNIQUE(user_id, token)
      );

      -- 유동성 풀 상태
      CREATE TABLE IF NOT EXISTS pools (
        id TEXT PRIMARY KEY,
        token_a TEXT NOT NULL,
        token_b TEXT NOT NULL,
        reserve_a REAL DEFAULT 0,
        reserve_b REAL DEFAULT 0,
        fee_bps INTEGER DEFAULT 30,
        total_lp_shares REAL DEFAULT 0,
        swap_count INTEGER DEFAULT 0,
        volume_24h REAL DEFAULT 0,
        fees_collected REAL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      -- LP 지분
      CREATE TABLE IF NOT EXISTS lp_shares (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        pool_id TEXT NOT NULL,
        shares REAL DEFAULT 0,
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (pool_id) REFERENCES pools(id),
        UNIQUE(user_id, pool_id)
      );

      -- 주문 (리밋 오더)
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        pool_id TEXT NOT NULL,
        side TEXT NOT NULL,
        price REAL NOT NULL,
        amount REAL NOT NULL,
        filled REAL DEFAULT 0,
        remaining REAL NOT NULL,
        status TEXT DEFAULT 'open',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      -- 스왑 기록
      CREATE TABLE IF NOT EXISTS swaps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        pool_id TEXT NOT NULL,
        token_in TEXT NOT NULL,
        token_out TEXT NOT NULL,
        amount_in REAL NOT NULL,
        amount_out REAL NOT NULL,
        fee REAL DEFAULT 0,
        slippage REAL DEFAULT 0,
        price_impact REAL DEFAULT 0,
        trit_state TEXT DEFAULT 'O',
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      -- 거래소 주문 (실제 Upbit/Binance)
      CREATE TABLE IF NOT EXISTS exchange_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        exchange TEXT NOT NULL,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        type TEXT NOT NULL,
        price REAL,
        quantity REAL NOT NULL,
        status TEXT DEFAULT 'pending',
        exchange_order_id TEXT,
        filled_qty REAL DEFAULT 0,
        filled_price REAL DEFAULT 0,
        fee REAL DEFAULT 0,
        source TEXT DEFAULT 'manual',
        ai_signal_id INTEGER,
        error TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      -- API 키 (암호화 저장)
      CREATE TABLE IF NOT EXISTS api_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        exchange TEXT NOT NULL,
        access_key_enc TEXT NOT NULL,
        secret_key_enc TEXT NOT NULL,
        iv TEXT NOT NULL,
        tag TEXT NOT NULL,
        permissions TEXT DEFAULT 'read',
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id),
        UNIQUE(user_id, exchange)
      );

      -- AI 시그널 기록
      CREATE TABLE IF NOT EXISTS ai_signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        exchange TEXT NOT NULL,
        interval_tf TEXT NOT NULL,
        signal TEXT NOT NULL,
        score REAL NOT NULL,
        confidence REAL NOT NULL,
        trit TEXT NOT NULL,
        strategies TEXT,
        risk_data TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- 자동매매 설정
      CREATE TABLE IF NOT EXISTS auto_trade_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        enabled INTEGER DEFAULT 0,
        exchange TEXT NOT NULL,
        symbols TEXT DEFAULT 'BTCUSDT',
        max_position_pct REAL DEFAULT 0.1,
        stop_loss_pct REAL DEFAULT 0.03,
        take_profit_pct REAL DEFAULT 0.06,
        min_confidence REAL DEFAULT 0.7,
        max_daily_trades INTEGER DEFAULT 10,
        daily_trades_used INTEGER DEFAULT 0,
        consecutive_losses INTEGER DEFAULT 0,
        max_consecutive_losses INTEGER DEFAULT 3,
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id),
        UNIQUE(user_id, exchange)
      );

      -- 세션/리프레시 토큰
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      -- 인덱스
      CREATE INDEX IF NOT EXISTS idx_wallets_user ON wallets(user_id);
      CREATE INDEX IF NOT EXISTS idx_orders_pool ON orders(pool_id, status);
      CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
      CREATE INDEX IF NOT EXISTS idx_swaps_user ON swaps(user_id);
      CREATE INDEX IF NOT EXISTS idx_swaps_pool ON swaps(pool_id);
      CREATE INDEX IF NOT EXISTS idx_exchange_orders_user ON exchange_orders(user_id);
      CREATE INDEX IF NOT EXISTS idx_ai_signals_symbol ON ai_signals(symbol, created_at);
    `);
  }

  // ════════════ User ════════════
  createUser(id, email, username, passwordHash) {
    return this.db.prepare(
      'INSERT INTO users (id, email, username, password_hash) VALUES (?, ?, ?, ?)'
    ).run(id, email, username, passwordHash);
  }

  getUserByEmail(email) {
    return this.db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  }

  getUserByUsername(username) {
    return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  }

  getUserById(id) {
    return this.db.prepare('SELECT id, email, username, role, created_at, last_login FROM users WHERE id = ?').get(id);
  }

  updateLastLogin(userId) {
    this.db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(userId);
  }

  // ════════════ Wallet ════════════
  getBalance(userId, token) {
    const row = this.db.prepare('SELECT balance, locked FROM wallets WHERE user_id = ? AND token = ?').get(userId, token);
    return row ? { balance: row.balance, locked: row.locked } : { balance: 0, locked: 0 };
  }

  getAllBalances(userId) {
    const rows = this.db.prepare('SELECT token, balance, locked FROM wallets WHERE user_id = ?').all(userId);
    const result = {};
    rows.forEach(r => result[r.token] = { balance: r.balance, locked: r.locked });
    return result;
  }

  setBalance(userId, token, balance) {
    this.db.prepare(`
      INSERT INTO wallets (user_id, token, balance, updated_at) VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(user_id, token) DO UPDATE SET balance = ?, updated_at = datetime('now')
    `).run(userId, token, balance, balance);
  }

  addBalance(userId, token, amount) {
    const current = this.getBalance(userId, token);
    this.setBalance(userId, token, current.balance + amount);
  }

  subtractBalance(userId, token, amount) {
    const current = this.getBalance(userId, token);
    if (current.balance < amount) throw new Error(`잔액 부족: ${token} (보유: ${current.balance}, 필요: ${amount})`);
    this.setBalance(userId, token, current.balance - amount);
  }

  lockBalance(userId, token, amount) {
    const current = this.getBalance(userId, token);
    if (current.balance - current.locked < amount) throw new Error(`가용 잔액 부족: ${token}`);
    this.db.prepare(`
      UPDATE wallets SET locked = locked + ?, updated_at = datetime('now') WHERE user_id = ? AND token = ?
    `).run(amount, userId, token);
  }

  unlockBalance(userId, token, amount) {
    this.db.prepare(`
      UPDATE wallets SET locked = MAX(0, locked - ?), updated_at = datetime('now') WHERE user_id = ? AND token = ?
    `).run(amount, userId, token);
  }

  // 초기 민팅
  mint(userId, token, amount) {
    this.addBalance(userId, token, amount);
  }

  // ════════════ Pool ════════════
  savePool(pool) {
    this.db.prepare(`
      INSERT INTO pools (id, token_a, token_b, reserve_a, reserve_b, fee_bps, total_lp_shares, swap_count, volume_24h, fees_collected, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET reserve_a=?, reserve_b=?, total_lp_shares=?, swap_count=?, volume_24h=?, fees_collected=?, updated_at=datetime('now')
    `).run(pool.id, pool.tokenA, pool.tokenB, pool.reserveA, pool.reserveB, pool.feeBps, pool.totalLpShares, pool.swapCount, pool.volume24h, pool.feesCollected,
      pool.reserveA, pool.reserveB, pool.totalLpShares, pool.swapCount, pool.volume24h, pool.feesCollected);
  }

  loadPools() {
    return this.db.prepare('SELECT * FROM pools').all();
  }

  // ════════════ Orders ════════════
  saveOrder(order) {
    this.db.prepare(`
      INSERT INTO orders (id, user_id, pool_id, side, price, amount, remaining, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET filled=?, remaining=?, status=?, updated_at=datetime('now')
    `).run(order.id, order.userId, order.poolId, order.side, order.price, order.amount, order.remaining, order.status,
      order.filled || 0, order.remaining, order.status);
  }

  getOpenOrders(poolId) {
    return this.db.prepare("SELECT * FROM orders WHERE pool_id = ? AND status = 'open' ORDER BY price").all(poolId);
  }

  getUserOrders(userId) {
    return this.db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(userId);
  }

  // ════════════ Swaps ════════════
  recordSwap(swap) {
    return this.db.prepare(`
      INSERT INTO swaps (user_id, pool_id, token_in, token_out, amount_in, amount_out, fee, slippage, price_impact, trit_state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(swap.userId, swap.poolId, swap.tokenIn, swap.tokenOut, swap.amountIn, swap.amountOut, swap.fee || 0, swap.slippage || 0, swap.priceImpact || 0, swap.tritState || 'O');
  }

  getRecentSwaps(limit = 50) {
    return this.db.prepare('SELECT * FROM swaps ORDER BY created_at DESC LIMIT ?').all(limit);
  }

  // ════════════ Exchange Orders ════════════
  saveExchangeOrder(order) {
    const stmt = this.db.prepare(`
      INSERT INTO exchange_orders (user_id, exchange, symbol, side, type, price, quantity, status, source, ai_signal_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(order.userId, order.exchange, order.symbol, order.side, order.type, order.price, order.quantity, order.status || 'pending', order.source || 'manual', order.aiSignalId || null);
    return result.lastInsertRowid;
  }

  updateExchangeOrder(id, updates) {
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(updates)) {
      const col = k.replace(/([A-Z])/g, '_$1').toLowerCase();
      sets.push(`${col} = ?`);
      vals.push(v);
    }
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.db.prepare(`UPDATE exchange_orders SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  getUserExchangeOrders(userId, limit = 30) {
    return this.db.prepare('SELECT * FROM exchange_orders WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, limit);
  }

  // ════════════ API Keys (Encrypted) ════════════
  saveApiKey(userId, exchange, accessKeyEnc, secretKeyEnc, iv, tag) {
    this.db.prepare(`
      INSERT INTO api_keys (user_id, exchange, access_key_enc, secret_key_enc, iv, tag)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, exchange) DO UPDATE SET access_key_enc=?, secret_key_enc=?, iv=?, tag=?
    `).run(userId, exchange, accessKeyEnc, secretKeyEnc, iv, tag, accessKeyEnc, secretKeyEnc, iv, tag);
  }

  getApiKey(userId, exchange) {
    return this.db.prepare('SELECT * FROM api_keys WHERE user_id = ? AND exchange = ?').get(userId, exchange);
  }

  deleteApiKey(userId, exchange) {
    this.db.prepare('DELETE FROM api_keys WHERE user_id = ? AND exchange = ?').run(userId, exchange);
  }

  // ════════════ AI Signals ════════════
  saveAiSignal(signal) {
    const result = this.db.prepare(`
      INSERT INTO ai_signals (symbol, exchange, interval_tf, signal, score, confidence, trit, strategies, risk_data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(signal.symbol, signal.exchange, signal.interval, signal.signal, signal.score, signal.confidence, signal.trit, JSON.stringify(signal.strategies), JSON.stringify(signal.risk));
    return result.lastInsertRowid;
  }

  getRecentSignals(symbol, limit = 20) {
    return this.db.prepare('SELECT * FROM ai_signals WHERE symbol = ? ORDER BY created_at DESC LIMIT ?').all(symbol, limit);
  }

  // ════════════ Auto-trade Config ════════════
  getAutoTradeConfig(userId, exchange) {
    return this.db.prepare('SELECT * FROM auto_trade_config WHERE user_id = ? AND exchange = ?').get(userId, exchange);
  }

  saveAutoTradeConfig(userId, exchange, config) {
    this.db.prepare(`
      INSERT INTO auto_trade_config (user_id, exchange, enabled, symbols, max_position_pct, stop_loss_pct, take_profit_pct, min_confidence, max_daily_trades)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, exchange) DO UPDATE SET enabled=?, symbols=?, max_position_pct=?, stop_loss_pct=?, take_profit_pct=?, min_confidence=?, max_daily_trades=?, updated_at=datetime('now')
    `).run(userId, exchange, config.enabled ? 1 : 0, config.symbols, config.maxPositionPct, config.stopLossPct, config.takeProfitPct, config.minConfidence, config.maxDailyTrades,
      config.enabled ? 1 : 0, config.symbols, config.maxPositionPct, config.stopLossPct, config.takeProfitPct, config.minConfidence, config.maxDailyTrades);
  }

  incrementDailyTrades(userId, exchange) {
    this.db.prepare("UPDATE auto_trade_config SET daily_trades_used = daily_trades_used + 1, updated_at = datetime('now') WHERE user_id = ? AND exchange = ?").run(userId, exchange);
  }

  resetDailyTrades() {
    this.db.prepare("UPDATE auto_trade_config SET daily_trades_used = 0, updated_at = datetime('now')").run();
  }

  incrementConsecutiveLosses(userId, exchange) {
    this.db.prepare("UPDATE auto_trade_config SET consecutive_losses = consecutive_losses + 1 WHERE user_id = ? AND exchange = ?").run(userId, exchange);
  }

  resetConsecutiveLosses(userId, exchange) {
    this.db.prepare("UPDATE auto_trade_config SET consecutive_losses = 0 WHERE user_id = ? AND exchange = ?").run(userId, exchange);
  }

  // ════════════ Session ════════════
  saveSession(id, userId, tokenHash, expiresAt) {
    this.db.prepare('INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)').run(id, userId, tokenHash, expiresAt);
  }

  deleteSession(id) {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  cleanExpiredSessions() {
    this.db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
  }

  // ════════════ Util ════════════
  close() {
    this.db.close();
  }

  transaction(fn) {
    return this.db.transaction(fn)();
  }
}

module.exports = { CrownyDB };
