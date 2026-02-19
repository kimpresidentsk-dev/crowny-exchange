// ═══════════════════════════════════════════════════════════════
// CrownyDEX Engine — JS Port (from Rust v0.13.0)
// AMM · 유동성 풀 · 오더북 · 스왑 · LP 보상
// ═══════════════════════════════════════════════════════════════

function tritHash(data) {
  let h = BigInt('0xcb735a4e9f1d2b08');
  const bytes = Buffer.from(data);
  for (let i = 0; i < bytes.length; i++) {
    h ^= BigInt(bytes[i]) * BigInt('0x100000001b3');
    h = (h * BigInt('0x517cc1b727220a95')) & BigInt('0xFFFFFFFFFFFFFFFF');
    h ^= (BigInt(i) + BigInt('0x9e3779b97f4a7c15')) & BigInt('0xFFFFFFFFFFFFFFFF');
    h = ((h << 17n) | (h >> 47n)) ^ ((h << 41n) | (h >> 23n));
    h &= BigInt('0xFFFFFFFFFFFFFFFF');
  }
  const trits = [];
  for (let i = 0; i < 27; i++) {
    const v = Number((h >> BigInt(i * 2)) & 3n) % 3;
    trits.push(['P','O','T'][v]);
  }
  return '0t' + trits.join('');
}

class Token {
  constructor(symbol, name, supply, decimals = 9) {
    this.symbol = symbol; this.name = name;
    this.totalSupply = supply; this.decimals = decimals;
    this.tritState = 1;
  }
}

class LiquidityPool {
  constructor(tokenA, tokenB, feeBps = 30) {
    this.id = `${tokenA}-${tokenB}`;
    this.tokenA = tokenA; this.tokenB = tokenB;
    this.reserveA = 0; this.reserveB = 0; this.k = 0;
    this.feeBps = feeBps;
    this.totalLpShares = 0; this.lpHolders = {};
    this.volume24h = 0; this.feesCollected = 0; this.swapCount = 0;
    this.priceHistory = []; this.tritState = 0;
    this.createdAt = Date.now();
  }

  addLiquidity(provider, amountA, amountB) {
    let shares;
    if (this.totalLpShares === 0) {
      shares = Math.floor(Math.sqrt(amountA * amountB));
    } else {
      const shareA = Math.floor(amountA * this.totalLpShares / this.reserveA);
      const shareB = Math.floor(amountB * this.totalLpShares / this.reserveB);
      shares = Math.min(shareA, shareB);
    }
    this.reserveA += amountA; this.reserveB += amountB;
    this.k = this.reserveA * this.reserveB;
    this.totalLpShares += shares;
    this.lpHolders[provider] = (this.lpHolders[provider] || 0) + shares;
    this.tritState = 1;
    this._recordPrice();
    return { poolId: this.id, provider, amountA, amountB, shares, action: 'add', trit: 1, ts: Date.now() };
  }

  removeLiquidity(provider, shares) {
    const held = this.lpHolders[provider] || 0;
    if (held < shares) throw new Error('LP 지분 부족');
    const amountA = Math.floor(shares * this.reserveA / this.totalLpShares);
    const amountB = Math.floor(shares * this.reserveB / this.totalLpShares);
    this.reserveA -= amountA; this.reserveB -= amountB;
    this.k = this.reserveA * this.reserveB;
    this.totalLpShares -= shares;
    this.lpHolders[provider] -= shares;
    this._recordPrice();
    return { poolId: this.id, provider, amountA, amountB, shares, action: 'remove', trit: 1, ts: Date.now() };
  }

  swapAtoB(amountIn) {
    if (this.reserveA === 0 || this.reserveB === 0) throw new Error('유동성 없음');
    const fee = Math.floor(amountIn * this.feeBps / 10000);
    const afterFee = amountIn - fee;
    const newA = this.reserveA + afterFee;
    const newB = Math.floor(this.k / newA);
    const amountOut = this.reserveB - newB;
    if (amountOut <= 0) throw new Error('출력량 0');
    const impact = 1.0 - (newB * this.reserveA) / (this.reserveB * newA);
    this.reserveA = newA; this.reserveB = newB;
    this.k = this.reserveA * this.reserveB;
    this.feesCollected += fee; this.volume24h += amountIn; this.swapCount++;
    const trit = impact < 0.01 ? 1 : impact < 0.05 ? 0 : -1;
    this._recordPrice();
    return { poolId: this.id, tokenIn: this.tokenA, tokenOut: this.tokenB, amountIn, amountOut, fee, impact, trit, hash: tritHash(`swap:${this.id}:${amountIn}:${Date.now()}`), ts: Date.now() };
  }

  swapBtoA(amountIn) {
    if (this.reserveA === 0 || this.reserveB === 0) throw new Error('유동성 없음');
    const fee = Math.floor(amountIn * this.feeBps / 10000);
    const afterFee = amountIn - fee;
    const newB = this.reserveB + afterFee;
    const newA = Math.floor(this.k / newB);
    const amountOut = this.reserveA - newA;
    if (amountOut <= 0) throw new Error('출력량 0');
    const impact = 1.0 - (newA * this.reserveB) / (this.reserveA * newB);
    this.reserveA = newA; this.reserveB = newB;
    this.k = this.reserveA * this.reserveB;
    this.feesCollected += fee; this.volume24h += amountIn; this.swapCount++;
    const trit = impact < 0.01 ? 1 : impact < 0.05 ? 0 : -1;
    this._recordPrice();
    return { poolId: this.id, tokenIn: this.tokenB, tokenOut: this.tokenA, amountIn, amountOut, fee, impact, trit, hash: tritHash(`swap:${this.id}:${amountIn}:${Date.now()}`), ts: Date.now() };
  }

  priceAinB() { return this.reserveA === 0 ? 0 : this.reserveB / this.reserveA; }
  priceBinA() { return this.reserveB === 0 ? 0 : this.reserveA / this.reserveB; }
  tvl(priceA, priceB) { return this.reserveA * priceA + this.reserveB * priceB; }

  _recordPrice() {
    this.priceHistory.push({ price: this.priceAinB(), ts: Date.now() });
    if (this.priceHistory.length > 1000) this.priceHistory.shift();
  }
}

class OrderBook {
  constructor() { this.orders = []; this.counter = 0; }

  place(owner, poolId, side, price, amount) {
    const o = { id: `ORD-${this.counter++}`, owner, poolId, side, price, amount, filled: 0, status: 'open', trit: 0, ts: Date.now() };
    this.orders.push(o);
    return o;
  }

  match(poolId) {
    const buys = this.orders.filter((o,i) => o.poolId === poolId && o.side === 'buy' && o.status === 'open').sort((a,b) => b.price - a.price);
    const sells = this.orders.filter((o,i) => o.poolId === poolId && o.side === 'sell' && o.status === 'open').sort((a,b) => a.price - b.price);
    const matches = [];
    for (const buy of buys) {
      for (const sell of sells) {
        if (buy.price >= sell.price) {
          const fill = Math.min(buy.amount - buy.filled, sell.amount - sell.filled);
          if (fill > 0) {
            buy.filled += fill; sell.filled += fill;
            buy.trit = 1; sell.trit = 1;
            buy.status = buy.filled >= buy.amount ? 'filled' : 'partial';
            sell.status = sell.filled >= sell.amount ? 'filled' : 'partial';
            matches.push({ buyId: buy.id, sellId: sell.id, fill, price: sell.price });
          }
        }
      }
    }
    return matches;
  }

  cancel(orderId) {
    const o = this.orders.find(x => x.id === orderId);
    if (o) { o.status = 'cancelled'; o.trit = -1; }
  }

  openOrders(poolId) { return this.orders.filter(o => o.poolId === poolId && o.status === 'open'); }
}

class CrownyDEX {
  constructor() {
    this.pools = {}; this.tokens = {}; this.balances = {};
    this.orderBook = new OrderBook();
    this.swapHistory = []; this.lpHistory = [];
    this.totalVolume = 0; this.totalFees = 0;
    // 기본 토큰
    this.registerToken('CRWN', 'Crowny Token', 153_000_000);
    this.registerToken('USDT', 'Tether USD', 1_000_000_000);
    this.registerToken('ETH', 'Ethereum', 120_000_000);
    this.registerToken('BTC', 'Bitcoin', 21_000_000);
    this.registerToken('TRIT', 'Trit Governance', 27_000_000);
    this.registerToken('KRW', 'Korean Won', 999_999_999_999);
    // 기본 풀 + 유동성
    this.createPool('CRWN','USDT', 30);
    this.createPool('CRWN','ETH', 30);
    this.createPool('CRWN','BTC', 30);
    this.createPool('CRWN','KRW', 20);
    this.createPool('BTC','USDT', 10);
    this.createPool('ETH','USDT', 15);
    // 초기 유동성 주입 (시스템)
    this._bootstrap();
  }

  _bootstrap() {
    const sys = '__system__';
    this.mint(sys, 'CRWN', 50_000_000); this.mint(sys, 'USDT', 20_000_000);
    this.mint(sys, 'ETH', 5000); this.mint(sys, 'BTC', 200);
    this.mint(sys, 'KRW', 500_000_000); this.mint(sys, 'TRIT', 1_000_000);
    this.addLiquidity(sys, 'CRWN-USDT', 10_000_000, 1_250_000);  // $0.125/CRWN
    this.addLiquidity(sys, 'CRWN-ETH', 5_000_000, 250);           // 20000 CRWN/ETH
    this.addLiquidity(sys, 'CRWN-BTC', 5_000_000, 50);            // 100000 CRWN/BTC
    this.addLiquidity(sys, 'CRWN-KRW', 5_000_000, 87_500_000);   // ₩17.5/CRWN
    this.addLiquidity(sys, 'BTC-USDT', 100, 9_800_000);           // $98000/BTC
    this.addLiquidity(sys, 'ETH-USDT', 2000, 6_600_000);          // $3300/ETH
  }

  registerToken(sym, name, supply) { this.tokens[sym] = new Token(sym, name, supply); }
  mint(user, token, amount) {
    if (!this.balances[user]) this.balances[user] = {};
    this.balances[user][token] = (this.balances[user][token] || 0) + amount;
  }
  balance(user, token) { return (this.balances[user] && this.balances[user][token]) || 0; }

  createPool(tokenA, tokenB, feeBps) {
    const pool = new LiquidityPool(tokenA, tokenB, feeBps);
    this.pools[pool.id] = pool;
    return pool.id;
  }

  addLiquidity(user, poolId, amountA, amountB) {
    const pool = this.pools[poolId]; if (!pool) throw new Error('풀 없음');
    if (this.balance(user, pool.tokenA) < amountA) throw new Error(`${pool.tokenA} 잔액 부족`);
    if (this.balance(user, pool.tokenB) < amountB) throw new Error(`${pool.tokenB} 잔액 부족`);
    this.balances[user][pool.tokenA] -= amountA;
    this.balances[user][pool.tokenB] -= amountB;
    const receipt = pool.addLiquidity(user, amountA, amountB);
    this.lpHistory.push(receipt);
    return receipt;
  }

  swap(user, poolId, tokenIn, amountIn) {
    const pool = this.pools[poolId]; if (!pool) throw new Error('풀 없음');
    if (this.balance(user, tokenIn) < amountIn) throw new Error(`${tokenIn} 잔액 부족`);
    this.balances[user][tokenIn] -= amountIn;
    const isAtoB = tokenIn === pool.tokenA;
    const result = isAtoB ? pool.swapAtoB(amountIn) : pool.swapBtoA(amountIn);
    const tokenOut = isAtoB ? pool.tokenB : pool.tokenA;
    if (!this.balances[user]) this.balances[user] = {};
    this.balances[user][tokenOut] = (this.balances[user][tokenOut] || 0) + result.amountOut;
    this.totalVolume += amountIn; this.totalFees += result.fee;
    this.swapHistory.push(result);
    return result;
  }

  placeOrder(user, poolId, side, price, amount) {
    return this.orderBook.place(user, poolId, side, price, amount);
  }
  matchOrders(poolId) { return this.orderBook.match(poolId); }

  summary() {
    return {
      tokens: Object.keys(this.tokens).length,
      pools: Object.keys(this.pools).length,
      swaps: this.swapHistory.length,
      orders: this.orderBook.orders.length,
      totalVolume: this.totalVolume,
      totalFees: this.totalFees,
      poolDetails: Object.values(this.pools).map(p => ({
        id: p.id, reserveA: p.reserveA, reserveB: p.reserveB,
        price: p.priceAinB(), swaps: p.swapCount, fees: p.feesCollected,
        tvl: p.reserveA + p.reserveB
      }))
    };
  }
}

module.exports = { CrownyDEX, Token, LiquidityPool, OrderBook, tritHash };
