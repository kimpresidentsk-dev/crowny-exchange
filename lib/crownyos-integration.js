// ═══════════════════════════════════════════════════════════════
// Crowny Exchange — CrownyOS Integration Layer
// TVM 프로세스 등록 · TritFS 데이터 마운트 · CTP 브릿지
// TritShell 명령어 · 시스템 서비스 관리
// ═══════════════════════════════════════════════════════════════
//
// CrownyOS는 Rust 기반 3진 운영체제이고,
// Exchange Platform은 Node.js입니다.
// 이 모듈이 둘을 연결하는 브릿지 역할을 합니다.
//
// ┌─────────────────────────────────────────────────┐
// │               CrownyOS (Rust/TVM)                │
// │  ┌────────────┐ ┌────────┐ ┌─────────────────┐  │
// │  │ TritShell   │ │ TritFS │ │  ProcessManager │  │
// │  │ crwn> dex   │ │/crwn/  │ │  PID: exchange  │  │
// │  │ crwn> ai    │ │exchange│ │  PID: gateway    │  │
// │  └──────┬─────┘ └───┬────┘ └────────┬────────┘  │
// │         │           │               │            │
// │  ┌──────▼───────────▼───────────────▼─────────┐  │
// │  │        CTP Protocol Bridge (포트 3333)      │  │
// │  │   CTP-T 패킷 ←→ HTTP/JSON 변환             │  │
// │  └──────────────────┬─────────────────────────┘  │
// │                     │                            │
// ├─────────────────────┼────────────────────────────┤
// │                     │  (localhost:7400)           │
// │  ┌──────────────────▼─────────────────────────┐  │
// │  │     Crowny Exchange Platform (Node.js)      │  │
// │  │  ┌─────┐ ┌────┐ ┌─────────┐ ┌──────────┐  │  │
// │  │  │ DEX │ │ AI │ │ Gateway │ │ DB(SQLite)│  │  │
// │  │  └─────┘ └────┘ └─────────┘ └──────────┘  │  │
// │  └────────────────────────────────────────────┘  │
// └──────────────────────────────────────────────────┘

// ═══════════════════════════════════════════════════
// 1. CrownyOS 서비스 등록 설정파일
// ═══════════════════════════════════════════════════
//
// 파일: /crwn/exchange/service.conf
// ─────────────────────────────────
// [service]
// name = crowny-exchange
// type = daemon
// priority = Normal
// memory = 65536
// 
// [process]
// command = node /crwn/exchange/server/index.js
// port = 7400
// protocol = http+ws+ctp
// auto_restart = true
// 
// [dependencies]
// requires = ctp-server, wallet-daemon, consensus-daemon
// 
// [trit]
// state = P
// health_check = http://localhost:7400/api/status
// health_interval = 30

const http = require('http');
const { EventEmitter } = require('events');

// ═══════════════════════════════════════════════════
// 2. CTP Protocol Bridge
//    CrownyOS CTP 패킷 ←→ HTTP JSON 변환
// ═══════════════════════════════════════════════════

class CTPBridge extends EventEmitter {
  constructor(exchangePort = 7400, ctpPort = 3334) {
    super();
    this.exchangePort = exchangePort;
    this.ctpPort = ctpPort;
    this.tritMap = { 'P': 1, 'O': 0, 'T': -1, '△': 1, '○': 0, '▽': -1 };
    this.connected = false;
  }

  // CTP 패킷 → JSON 변환
  parseCTPPacket(buffer) {
    // CTP-T 패킷 구조:
    // [3B magic: CTP] [1B version] [1B type] [2B length] [payload]
    if (buffer.length < 7) return null;
    
    const magic = buffer.slice(0, 3).toString();
    if (magic !== 'CTP') return null;

    const version = buffer[3];
    const type = buffer[4]; // 0=request, 1=response, 2=event
    const length = buffer.readUInt16BE(5);
    const payload = buffer.slice(7, 7 + length).toString('utf-8');

    try {
      return { version, type, data: JSON.parse(payload) };
    } catch (e) {
      // Trit-encoded payload → 디코드
      return { version, type, data: this.decodeTritPayload(payload) };
    }
  }

  // JSON → CTP 패킷 변환
  buildCTPPacket(type, data) {
    const payload = Buffer.from(JSON.stringify(data), 'utf-8');
    const header = Buffer.alloc(7);
    header.write('CTP', 0);
    header[3] = 2; // version 2.0
    header[4] = type; // 0=req, 1=resp, 2=event
    header.writeUInt16BE(payload.length, 5);
    return Buffer.concat([header, payload]);
  }

  // Trit-encoded 데이터 디코딩
  decodeTritPayload(tritStr) {
    // Ti=△(+1), Om=○(0), Ta=▽(-1) 인코딩 디코드
    const trits = [];
    for (const char of tritStr) {
      if (this.tritMap[char] !== undefined) trits.push(this.tritMap[char]);
    }
    return { trits, raw: tritStr };
  }

  // Exchange API 호출 (내부)
  async callExchange(method, path, body = null, token = null) {
    return new Promise((resolve, reject) => {
      const opts = {
        hostname: 'localhost',
        port: this.exchangePort,
        path,
        method,
        headers: { 'Content-Type': 'application/json' }
      };
      if (token) opts.headers.Authorization = `Bearer ${token}`;
      
      const req = http.request(opts, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch(e) { resolve({ error: data }); }
        });
      });
      req.on('error', reject);
      req.setTimeout(5000, () => { req.destroy(); reject(new Error('Timeout')); });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  // CTP 라우팅 → Exchange API
  async routeCTP(packet) {
    const { service, action, params, token } = packet.data;
    
    const routeMap = {
      // DEX
      'dex.pools':     { method: 'GET',  path: '/api/dex/pools' },
      'dex.balances':  { method: 'GET',  path: '/api/dex/balances', auth: true },
      'dex.swap':      { method: 'POST', path: '/api/dex/swap', auth: true },
      'dex.order':     { method: 'POST', path: '/api/dex/order', auth: true },
      'dex.orderbook': { method: 'GET',  path: '/api/dex/orderbook' },
      'dex.history':   { method: 'GET',  path: '/api/dex/history' },
      // AI
      'ai.analyze':    { method: 'GET',  path: '/api/ai/analyze' },
      'ai.backtest':   { method: 'GET',  path: '/api/ai/backtest' },
      'ai.multi':      { method: 'GET',  path: '/api/ai/multi-analyze' },
      // Exchange
      'exchange.order':   { method: 'POST', path: '/api/exchange/order', auth: true },
      'exchange.cancel':  { method: 'POST', path: '/api/exchange/cancel', auth: true },
      'exchange.balance': { method: 'GET',  path: '/api/exchange/balance', auth: true },
      // Auto
      'auto.enable':   { method: 'POST', path: '/api/auto/enable', auth: true },
      'auto.disable':  { method: 'POST', path: '/api/auto/disable', auth: true },
      'auto.status':   { method: 'GET',  path: '/api/auto/status', auth: true },
      // Auth
      'auth.login':    { method: 'POST', path: '/api/auth/login' },
      'auth.register': { method: 'POST', path: '/api/auth/register' },
      'auth.me':       { method: 'GET',  path: '/api/auth/me', auth: true },
      // System
      'system.status': { method: 'GET',  path: '/api/status' },
      'system.events': { method: 'GET',  path: '/api/events', auth: true },
    };

    const key = `${service}.${action}`;
    const route = routeMap[key];
    if (!route) {
      return this.buildCTPPacket(1, { trit: 'T', error: `Unknown route: ${key}` });
    }

    try {
      let path = route.path;
      // GET params → query string
      if (route.method === 'GET' && params) {
        const qs = new URLSearchParams(params).toString();
        if (qs) path += '?' + qs;
      }

      const result = await this.callExchange(
        route.method, path,
        route.method === 'POST' ? params : null,
        route.auth ? token : null
      );

      // 응답에 Trit 상태 추가
      result._trit = result.error ? 'T' : result.success === false ? 'O' : 'P';
      return this.buildCTPPacket(1, result);

    } catch (e) {
      return this.buildCTPPacket(1, { trit: 'T', error: e.message });
    }
  }

  // 헬스체크 (CrownyOS 데몬 모니터링용)
  async healthCheck() {
    try {
      const result = await this.callExchange('GET', '/api/status');
      return {
        trit: 'P',
        status: 'healthy',
        services: result.services,
        uptime: result.uptime
      };
    } catch (e) {
      return { trit: 'T', status: 'unhealthy', error: e.message };
    }
  }
}

// ═══════════════════════════════════════════════════
// 3. TritShell Commands
//    CrownyOS 셸에서 거래소 조작
// ═══════════════════════════════════════════════════

class ExchangeShellCommands {
  constructor(bridge) {
    this.bridge = bridge;
    this.sessionToken = null;
    this.currentUser = null;
  }

  // 셸 명령어 등록 (TritShell에 추가)
  getCommands() {
    return {
      'dex': '  dex [sub]           DEX 거래소 (pools|swap|order|book|balance)',
      'ai':  '  ai [sub]            AI 트레이딩 (analyze|backtest|scan|auto)',
      'exchange': '  exchange [sub]  거래소 (login|balance|order|cancel)',
      'trade': '  trade [sub]        자동매매 (enable|disable|status)',
      'market': '  market [sub]      시세 (prices|chart)',
    };
  }

  // 명령어 실행
  async execute(cmd, args) {
    const output = [];
    const trit = { state: 'P' };

    try {
      switch (cmd) {
        // ─── DEX ───
        case 'dex':
          return await this._dexCommand(args, output);

        // ─── AI ───
        case 'ai':
          return await this._aiCommand(args, output);

        // ─── Exchange ───
        case 'exchange':
          return await this._exchangeCommand(args, output);

        // ─── Auto-trade ───
        case 'trade':
          return await this._tradeCommand(args, output);

        // ─── Market ───
        case 'market':
          return await this._marketCommand(args, output);

        default:
          output.push(`  [T] 알 수 없는 명령어: ${cmd}`);
          return { trit: -1, output };
      }
    } catch (e) {
      output.push(`  [T] 오류: ${e.message}`);
      return { trit: -1, output };
    }
  }

  async _dexCommand(args, output) {
    const sub = args[0] || 'help';

    switch (sub) {
      case 'pools': {
        const result = await this.bridge.callExchange('GET', '/api/dex/pools');
        output.push('  ─── DEX 풀 목록 ───');
        output.push('  POOL            PRICE        TVL          SWAPS   FEE');
        for (const p of (result.pools || [])) {
          output.push(`  [P] ${p.id.padEnd(14)} ${p.price.toFixed(4).padStart(10)}  ${(p.reserveA + p.reserveB).toLocaleString().padStart(12)}  ${String(p.swapCount).padStart(5)}  ${p.feeBps}bp`);
        }
        return { trit: 1, output };
      }

      case 'balance': {
        if (!this.sessionToken) { output.push('  [T] 로그인 필요: exchange login <email> <password>'); return { trit: -1, output }; }
        const result = await this.bridge.callExchange('GET', '/api/dex/balances', null, this.sessionToken);
        output.push('  ─── 지갑 잔액 ───');
        for (const [token, amount] of Object.entries(result.balances || {})) {
          const bar = '█'.repeat(Math.min(20, Math.floor(Math.log10(Math.max(amount, 1)) * 3)));
          output.push(`  [P] ${token.padEnd(6)} ${String(amount).padStart(14)} ${bar}`);
        }
        return { trit: 1, output };
      }

      case 'swap': {
        if (!this.sessionToken) { output.push('  [T] 로그인 필요'); return { trit: -1, output }; }
        const [pool, tokenIn, amount] = args.slice(1);
        if (!pool || !tokenIn || !amount) {
          output.push('  사용법: dex swap <풀ID> <토큰> <수량>');
          output.push('  예시:   dex swap CRWN-USDT CRWN 1000');
          return { trit: 0, output };
        }
        const result = await this.bridge.callExchange('POST', '/api/dex/swap', { poolId: pool, tokenIn, amount: parseInt(amount) }, this.sessionToken);
        if (result.success) {
          output.push(`  [P] 스왑 완료: ${amount} ${tokenIn} → ${result.result?.amountOut || '?'}`);
        } else {
          output.push(`  [T] 스왑 실패: ${result.error}`);
        }
        return { trit: result.success ? 1 : -1, output };
      }

      case 'book': {
        const pool = args[1] || 'CRWN-USDT';
        const result = await this.bridge.callExchange('GET', `/api/dex/orderbook?pool=${pool}`);
        output.push(`  ─── 오더북: ${pool} ───`);
        const orders = result.orders || [];
        const bids = orders.filter(o => o.side === 'buy').sort((a, b) => b.price - a.price).slice(0, 5);
        const asks = orders.filter(o => o.side === 'sell').sort((a, b) => a.price - b.price).slice(0, 5);
        output.push('  매도(ASK)');
        for (const o of asks.reverse()) {
          output.push(`  [T] ${o.price.toFixed(4).padStart(12)} │ ${String(o.remaining).padStart(10)}`);
        }
        output.push('  ────────────┼───────────');
        for (const o of bids) {
          output.push(`  [P] ${o.price.toFixed(4).padStart(12)} │ ${String(o.remaining).padStart(10)}`);
        }
        output.push('  매수(BID)');
        return { trit: 1, output };
      }

      default:
        output.push('  ─── DEX 명령어 ───');
        output.push('  dex pools              풀 목록');
        output.push('  dex balance            잔액 조회');
        output.push('  dex swap <풀> <토큰> <양>  스왑 실행');
        output.push('  dex book [풀]          오더북');
        output.push('  dex order <풀> <buy|sell> <가격> <양>  주문');
        return { trit: 0, output };
    }
  }

  async _aiCommand(args, output) {
    const sub = args[0] || 'help';

    switch (sub) {
      case 'analyze': {
        const symbol = args[1] || 'BTCUSDT';
        const interval = args[2] || '1h';
        output.push(`  ─── AI 분석: ${symbol} (${interval}) ───`);
        output.push(`  분석 중...`);
        const result = await this.bridge.callExchange('GET', `/api/ai/analyze?symbol=${symbol}&interval=${interval}`);
        
        if (result.consensus) {
          const c = result.consensus;
          const emoji = c.signal === 'BUY' ? '△' : c.signal === 'SELL' ? '▽' : '○';
          output.push(`  ${emoji} 시그널: ${c.signal}  점수: ${c.score?.toFixed(3) || '?'}  신뢰도: ${((c.confidence || 0) * 100).toFixed(0)}%`);
          output.push('');
          if (result.strategies) {
            for (const s of result.strategies) {
              const se = s.signal === 'BUY' ? '△' : s.signal === 'SELL' ? '▽' : '○';
              output.push(`  ${se} ${s.name?.padEnd(12) || '?'.padEnd(12)} ${s.signal?.padEnd(4) || '?'} (${((s.confidence || 0) * 100).toFixed(0)}%) ${s.reason || ''}`);
            }
          }
          if (result.risk) {
            output.push('');
            output.push(`  리스크: ${result.risk.allowed ? '[P] 거래 허용' : '[T] 거래 차단'}`);
          }
        } else {
          output.push(`  [T] ${result.error || '분석 실패'}`);
        }
        return { trit: result.consensus ? 1 : -1, output };
      }

      case 'backtest': {
        const symbol = args[1] || 'BTCUSDT';
        const balance = args[2] || '10000000';
        output.push(`  ─── 백테스트: ${symbol} (초기: ₩${parseInt(balance).toLocaleString()}) ───`);
        const result = await this.bridge.callExchange('GET', `/api/ai/backtest?symbol=${symbol}&balance=${balance}`);
        if (result.stats) {
          const s = result.stats;
          output.push(`  최종 잔액: ₩${s.finalBalance?.toLocaleString() || '?'}`);
          output.push(`  수익률:    ${s.returnPct?.toFixed(2) || '?'}%`);
          output.push(`  총 거래:   ${s.totalTrades || '?'}회 (승률: ${s.winRate?.toFixed(1) || '?'}%)`);
          output.push(`  최대 DD:   ${s.maxDrawdown?.toFixed(2) || '?'}%`);
          output.push(`  Sharpe:    ${s.sharpe?.toFixed(3) || '?'}`);
        }
        return { trit: 1, output };
      }

      case 'scan': {
        output.push('  ─── 멀티 심볼 스캔 ───');
        const result = await this.bridge.callExchange('GET', '/api/ai/multi-analyze?symbols=BTCUSDT,ETHUSDT,XRPUSDT,SOLUSDT,DOGEUSDT,ADAUSDT');
        for (const r of (result.results || [])) {
          const c = r.consensus;
          const emoji = c.signal === 'BUY' ? '△' : c.signal === 'SELL' ? '▽' : '○';
          output.push(`  ${emoji} ${(r.symbol || '?').padEnd(10)} ${c.signal?.padEnd(4)} score:${c.score?.toFixed(3) || '?'} conf:${((c.confidence || 0) * 100).toFixed(0)}%`);
        }
        return { trit: 1, output };
      }

      default:
        output.push('  ─── AI 명령어 ───');
        output.push('  ai analyze [심볼] [간격]  AI 분석');
        output.push('  ai backtest [심볼] [잔액]  백테스트');
        output.push('  ai scan                    멀티 스캔');
        return { trit: 0, output };
    }
  }

  async _exchangeCommand(args, output) {
    const sub = args[0] || 'help';

    switch (sub) {
      case 'login': {
        const email = args[1];
        const password = args[2];
        if (!email || !password) {
          output.push('  사용법: exchange login <이메일> <비밀번호>');
          return { trit: 0, output };
        }
        const result = await this.bridge.callExchange('POST', '/api/auth/login', { email, password });
        if (result.success) {
          this.sessionToken = result.token;
          this.currentUser = result.user;
          output.push(`  [P] 로그인 성공: ${result.user.username}`);
        } else {
          output.push(`  [T] 로그인 실패: ${result.error}`);
        }
        return { trit: result.success ? 1 : -1, output };
      }

      case 'register': {
        const [email, username, password] = args.slice(1);
        if (!email || !username || !password) {
          output.push('  사용법: exchange register <이메일> <사용자명> <비밀번호>');
          return { trit: 0, output };
        }
        const result = await this.bridge.callExchange('POST', '/api/auth/register', { email, username, password });
        if (result.success) {
          this.sessionToken = result.token;
          this.currentUser = result.user;
          output.push(`  [P] 계정 생성: ${result.user.username} (CRWN 1M + USDT 500K 지급)`);
        } else {
          output.push(`  [T] 가입 실패: ${result.error}`);
        }
        return { trit: result.success ? 1 : -1, output };
      }

      case 'whoami': {
        if (!this.currentUser) { output.push('  [T] 로그인 필요'); return { trit: -1, output }; }
        output.push(`  [P] ${this.currentUser.username} (${this.currentUser.email})`);
        return { trit: 1, output };
      }

      case 'logout': {
        this.sessionToken = null;
        this.currentUser = null;
        output.push('  [P] 로그아웃 완료');
        return { trit: 1, output };
      }

      case 'apikey': {
        if (!this.sessionToken) { output.push('  [T] 로그인 필요'); return { trit: -1, output }; }
        const [action, exchange, accessKey, secretKey] = args.slice(1);
        if (action === 'set' && exchange && accessKey && secretKey) {
          const result = await this.bridge.callExchange('POST', '/api/settings/api-keys', { exchange, accessKey, secretKey }, this.sessionToken);
          output.push(result.success ? `  [P] ${exchange} API 키 저장 (AES-256-GCM 암호화)` : `  [T] ${result.error}`);
        } else if (action === 'show') {
          const ex = exchange || 'binance';
          const result = await this.bridge.callExchange('GET', `/api/settings/api-keys?exchange=${ex}`, null, this.sessionToken);
          if (result.keys) {
            output.push(`  [P] ${ex}: ${result.keys.accessKey}`);
          } else {
            output.push(`  [O] ${ex} API 키 미설정`);
          }
        } else {
          output.push('  사용법: exchange apikey set <binance|upbit> <access> <secret>');
          output.push('         exchange apikey show [binance|upbit]');
        }
        return { trit: 1, output };
      }

      default:
        output.push('  ─── 거래소 명령어 ───');
        output.push('  exchange login <이메일> <비밀번호>     로그인');
        output.push('  exchange register <이메일> <이름> <PW>  회원가입');
        output.push('  exchange whoami                        현재 사용자');
        output.push('  exchange logout                        로그아웃');
        output.push('  exchange apikey set <거래소> <AK> <SK>  API키 등록');
        output.push('  exchange apikey show [거래소]           API키 확인');
        return { trit: 0, output };
    }
  }

  async _tradeCommand(args, output) {
    const sub = args[0] || 'help';
    if (!this.sessionToken) { output.push('  [T] 로그인 필요: exchange login'); return { trit: -1, output }; }

    switch (sub) {
      case 'enable': {
        const exchange = args[1] || 'binance';
        const result = await this.bridge.callExchange('POST', '/api/auto/enable', { exchange }, this.sessionToken);
        output.push(result.success ? `  [P] ${exchange} 자동매매 활성화 △` : `  [T] ${result.error}`);
        return { trit: result.success ? 1 : -1, output };
      }
      case 'disable': {
        const exchange = args[1] || 'binance';
        const result = await this.bridge.callExchange('POST', '/api/auto/disable', { exchange }, this.sessionToken);
        output.push(result.success ? `  [P] ${exchange} 자동매매 비활성화 ▽` : `  [T] ${result.error}`);
        return { trit: result.success ? 1 : -1, output };
      }
      case 'status': {
        const exchange = args[1] || 'binance';
        const result = await this.bridge.callExchange('GET', `/api/auto/status?exchange=${exchange}`, null, this.sessionToken);
        if (result.config) {
          const c = result.config;
          output.push(`  ─── 자동매매 상태: ${exchange} ───`);
          output.push(`  활성: ${c.enabled ? '△ ON' : '▽ OFF'}  실행중: ${result.running ? '예' : '아니오'}`);
          output.push(`  심볼: ${c.symbols}`);
          output.push(`  일일 거래: ${c.daily_trades_used}/${c.max_daily_trades}`);
          output.push(`  연속 손실: ${c.consecutive_losses}/${c.max_consecutive_losses}`);
          output.push(`  최소 신뢰도: ${(c.min_confidence * 100).toFixed(0)}%`);
          output.push(`  포지션 한도: ${(c.max_position_pct * 100).toFixed(0)}%`);
        } else {
          output.push('  [O] 자동매매 미설정');
        }
        return { trit: 1, output };
      }
      default:
        output.push('  ─── 자동매매 명령어 ───');
        output.push('  trade enable [거래소]    자동매매 시작');
        output.push('  trade disable [거래소]   자동매매 중지');
        output.push('  trade status [거래소]    상태 확인');
        return { trit: 0, output };
    }
  }

  async _marketCommand(args, output) {
    const sub = args[0] || 'prices';
    switch (sub) {
      case 'prices': {
        const result = await this.bridge.callExchange('GET', '/api/market/prices');
        output.push('  ─── 실시간 시세 ───');
        if (result.binance) {
          for (const [sym, price] of Object.entries(result.binance)) {
            output.push(`  ${sym.padEnd(10)} $${parseFloat(price).toLocaleString()}`);
          }
        }
        if (result.kimchiPremium) {
          output.push(`\n  김치 프리미엄: ${result.kimchiPremium.toFixed(2)}%`);
        }
        return { trit: 1, output };
      }
      default:
        output.push('  market prices    실시간 시세');
        return { trit: 0, output };
    }
  }
}

// ═══════════════════════════════════════════════════
// 4. TritFS Integration
//    CrownyOS 파일시스템에 거래소 데이터 매핑
// ═══════════════════════════════════════════════════

class TritFSExchangeMount {
  // /crwn/exchange/ 하위 가상 파일시스템 구조
  static getStructure() {
    return {
      '/crwn/exchange/': {
        'server/': { 'index.js': 'Exchange Server v2.0' },
        'lib/': {
          'db.js': 'SQLite Database Layer',
          'auth.js': 'JWT + AES-256-GCM Auth',
          'dex-engine.js': 'AMM + Orderbook Engine',
          'trading-ai.js': '6-Strategy AI Engine',
          'exchange-api.js': 'Upbit/Binance Connectors',
          'trade-executor.js': 'Private API Trade Executor',
          'gateway.js': 'MetaKernel Gateway',
        },
        'public/': {
          'login.html': 'Login/Register GUI',
          'dex.html': 'DEX Trading GUI',
          'ai.html': 'AI Trading GUI',
          'index.html': 'Dashboard',
        },
        'data/': {
          'crowny.db': 'SQLite Database (users, wallets, orders, signals)',
        },
        'config/': {
          'service.conf': 'OS Service Configuration',
          '.env': 'Environment Variables',
        }
      }
    };
  }

  // TritFS에 마운트할 서비스 설정 파일 내용
  static getServiceConf() {
    return `# CrownyOS Exchange Service
[service]
name = crowny-exchange
version = 2.0
type = daemon
priority = Normal
memory_kb = 65536
trit_state = P

[process]
command = node /crwn/exchange/server/index.js
port = 7400
protocol = http+ws+ctp
auto_restart = true
log_file = /var/log/exchange.log

[dependencies]
requires = ctp-server,wallet-daemon
optional = consensus-daemon

[health]
check_url = http://localhost:7400/api/status
interval_sec = 30
timeout_sec = 5
restart_on_fail = true
max_restarts = 3

[security]
tls = false
cors = localhost
rate_limit = 100/min
jwt_expiry = 24h
api_key_encryption = aes-256-gcm

[dex]
pools = 6
tokens = 6
fee_bps = 30

[ai]
strategies = 6
consensus = 3-trit
auto_trade_interval = 30s
min_confidence = 70

[trit]
protocol = CTP-T
header = △○▽
version = 2.0
`;
  }
}

// ═══════════════════════════════════════════════════
// 5. OS 통합 스타트업
// ═══════════════════════════════════════════════════

class CrownyOSExchangeService {
  constructor() {
    this.bridge = new CTPBridge();
    this.commands = new ExchangeShellCommands(this.bridge);
    this.started = false;
  }

  // TritShell에 명령어 등록하는 패치 코드
  //
  // Rust 측 TritShell.execute()에 다음 추가:
  // ───────────────────────────────────
  // "dex" | "ai" | "exchange" | "trade" | "market" => {
  //     // CTP Bridge를 통해 Node.js Exchange 서비스 호출
  //     let args: Vec<&str> = parts[1..].to_vec();
  //     match ctp_call(actual_cmd, args) {
  //         Ok(result) => {
  //             for line in result.output { self.output.push(line); }
  //             self.exit_trit = result.trit;
  //         }
  //         Err(e) => {
  //             self.output.push(format!("  [T] Exchange 서비스 오류: {}", e));
  //             self.exit_trit = -1;
  //         }
  //     }
  // }
  // ───────────────────────────────────

  getStartupBanner() {
    return `
    [P] crowny-exchange 서비스 시작...
    [P]   DEX Engine:    6 pools · 6 tokens · AMM+Orderbook
    [P]   Trading AI:    6 strategies · 3-Trit consensus  
    [P]   Exchange API:  Upbit + Binance (Private + Public)
    [P]   MetaKernel:    Gateway + Auto-trade pipeline
    [P]   Database:      SQLite (AES-256-GCM encrypted)
    [P]   HTTP:          http://localhost:7400
    [P]   WebSocket:     ws://localhost:7400
    [P]   CTP Bridge:    port 3334
    [P] ✓ crowny-exchange 서비스 활성 △
`;
  }

  // Mac에서 실행하는 방법
  static getInstallInstructions() {
    return `
═══════════════════════════════════════════════════════
  CrownyOS에서 Exchange Platform 실행 방법
═══════════════════════════════════════════════════════

── 방법 1: TritShell에서 직접 실행 ──

  crwn> cd /crwn/exchange
  crwn> spawn crowny-exchange 65536
  # → Node.js 서버가 CrownyOS 프로세스로 등록됨

  # 셸에서 바로 사용:
  crwn> exchange login test@crowny.io test123
  crwn> dex pools
  crwn> ai analyze BTCUSDT 1h
  crwn> trade enable binance
  crwn> dex swap CRWN-USDT CRWN 1000


── 방법 2: Mac 터미널에서 병렬 실행 ──

  # 터미널 1: CrownyOS TVM
  $ cd ~/.openclaw && ./crowni-tvm
  
  # 터미널 2: Exchange Platform  
  $ cd /crwn/exchange && node server/index.js
  
  # 터미널 3: (선택) Crowny Browser
  $ open -a "Crowny Browser"
  # → http://localhost:7400/dex 접속


── 방법 3: 시스템 서비스 자동시작 ──

  # CrownyOS 부팅 시 자동 실행 등록:
  crwn> export EXCHANGE_AUTOSTART=true
  
  # /etc/crowny.conf에 추가:
  # [services]
  # exchange = /crwn/exchange/server/index.js
  # exchange_port = 7400
  # exchange_autostart = true

  # 또는 TVM main.rs에서:
  # CrownyOS::boot() 내부에 추가:
  # os.pm.spawn("crowny-exchange", "root", ProcessPriority::Normal, 65536);


── 파일 배치 ──

  ~/.openclaw/          # CrownyOS TVM 홈
  ├── crowni-tvm        # TVM 바이너리
  └── crwn/
      └── exchange/     # ← 여기에 복사
          ├── server/
          │   └── index.js
          ├── lib/
          │   ├── db.js
          │   ├── auth.js
          │   ├── dex-engine.js
          │   ├── trading-ai.js
          │   ├── exchange-api.js
          │   ├── trade-executor.js
          │   └── gateway.js
          ├── public/
          │   ├── login.html
          │   ├── dex.html
          │   ├── ai.html
          │   └── index.html
          ├── data/         # 자동 생성
          │   └── crowny.db
          ├── node_modules/
          └── package.json


── GUI 접속 ──

  Crowny Browser:  ctp://exchange.crowny/dex
  일반 브라우저:    http://localhost:7400/dex
  
  DEX GUI:  /dex   (3패널 트레이딩)
  AI GUI:   /ai    (시그널 + 백테스트)
  로그인:   /login (회원가입/로그인)
`;
  }
}

module.exports = {
  CTPBridge,
  ExchangeShellCommands,
  TritFSExchangeMount,
  CrownyOSExchangeService
};
