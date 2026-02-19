// ═══════════════════════════════════════════════════════════════
// Crowny Exchange — Auth Module
// JWT 인증 + bcrypt 비밀번호 + 세션 관리
// ═══════════════════════════════════════════════════════════════

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const JWT_SECRET = process.env.JWT_SECRET || 'crowny-exchange-dev-secret-change-in-production-' + crypto.randomBytes(16).toString('hex');
const JWT_EXPIRES = '24h';
const SALT_ROUNDS = 12;

class AuthManager {
  constructor(db) {
    this.db = db;
  }

  // ─── 회원가입 ───
  async register(email, username, password) {
    // 검증
    if (!email || !username || !password) throw new Error('이메일, 사용자명, 비밀번호를 모두 입력하세요');
    if (password.length < 6) throw new Error('비밀번호는 6자 이상이어야 합니다');
    if (username.length < 2) throw new Error('사용자명은 2자 이상이어야 합니다');
    if (!/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email)) throw new Error('유효한 이메일을 입력하세요');

    // 중복 검사
    if (this.db.getUserByEmail(email)) throw new Error('이미 사용 중인 이메일입니다');
    if (this.db.getUserByUsername(username)) throw new Error('이미 사용 중인 사용자명입니다');

    // 생성
    const id = uuidv4();
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    this.db.createUser(id, email, username, passwordHash);

    // 초기 잔액 민팅
    this.db.mint(id, 'CRWN', 1_000_000);
    this.db.mint(id, 'USDT', 500_000);
    this.db.mint(id, 'ETH', 100);
    this.db.mint(id, 'BTC', 5);
    this.db.mint(id, 'KRW', 100_000_000);

    // 토큰 발급
    const token = this._generateToken(id, username, 'user');
    return { user: { id, email, username, role: 'user' }, token };
  }

  // ─── 로그인 ───
  async login(emailOrUsername, password) {
    if (!emailOrUsername || !password) throw new Error('이메일/사용자명과 비밀번호를 입력하세요');

    // 사용자 조회
    let user = this.db.getUserByEmail(emailOrUsername);
    if (!user) user = this.db.getUserByUsername(emailOrUsername);
    if (!user) throw new Error('사용자를 찾을 수 없습니다');

    // 비밀번호 검증
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) throw new Error('비밀번호가 일치하지 않습니다');

    // 마지막 로그인 업데이트
    this.db.updateLastLogin(user.id);

    // 토큰 발급
    const token = this._generateToken(user.id, user.username, user.role);
    return {
      user: { id: user.id, email: user.email, username: user.username, role: user.role },
      token
    };
  }

  // ─── 토큰 검증 (미들웨어) ───
  verifyToken(token) {
    if (!token) return null;
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      return decoded;
    } catch (e) {
      return null;
    }
  }

  // HTTP 요청에서 토큰 추출
  extractToken(req) {
    const auth = req.headers?.authorization;
    if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
    // URL 파라미터 (WebSocket 용)
    const url = new URL(req.url, 'http://localhost');
    return url.searchParams.get('token');
  }

  // 인증 미들웨어 (요청에서 사용자 추출)
  authenticate(req) {
    const token = this.extractToken(req);
    if (!token) return null;
    const decoded = this.verifyToken(token);
    if (!decoded) return null;
    return { id: decoded.userId, username: decoded.username, role: decoded.role };
  }

  // 관리자 권한 체크
  requireAdmin(user) {
    if (!user || user.role !== 'admin') throw new Error('관리자 권한이 필요합니다');
    return true;
  }

  // ─── 비밀번호 변경 ───
  async changePassword(userId, currentPassword, newPassword) {
    const user = this.db.db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) throw new Error('사용자를 찾을 수 없습니다');

    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) throw new Error('현재 비밀번호가 일치하지 않습니다');

    if (newPassword.length < 6) throw new Error('새 비밀번호는 6자 이상이어야 합니다');

    const newHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    this.db.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, userId);
    return true;
  }

  // ─── 내부 ───
  _generateToken(userId, username, role) {
    return jwt.sign(
      { userId, username, role, iat: Math.floor(Date.now() / 1000) },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES }
    );
  }
}

// ═══════════════════════════════════════════════════════════════
// API 키 암호화 유틸 (AES-256-GCM)
// ═══════════════════════════════════════════════════════════════

const ENC_KEY = process.env.ENCRYPTION_KEY
  ? Buffer.from(process.env.ENCRYPTION_KEY, 'hex')
  : crypto.scryptSync('crowny-dev-key-change-this', 'crowny-salt', 32);

class CryptoUtil {
  static encrypt(plaintext) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag().toString('hex');
    return { encrypted, iv: iv.toString('hex'), tag };
  }

  static decrypt(encrypted, ivHex, tagHex) {
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }
}

class ApiKeyManager {
  constructor(db) {
    this.db = db;
  }

  // API 키 저장 (암호화)
  save(userId, exchange, accessKey, secretKey) {
    const accEnc = CryptoUtil.encrypt(accessKey);
    const secEnc = CryptoUtil.encrypt(secretKey);
    // 두 키에 같은 iv/tag 묶음 사용 (간소화)
    const combined = JSON.stringify({ acc: accEnc, sec: secEnc });
    const { encrypted, iv, tag } = CryptoUtil.encrypt(combined);
    this.db.saveApiKey(userId, exchange, accEnc.encrypted, secEnc.encrypted, accEnc.iv + ':' + secEnc.iv, accEnc.tag + ':' + secEnc.tag);
    return true;
  }

  // API 키 복호화 조회
  get(userId, exchange) {
    const row = this.db.getApiKey(userId, exchange);
    if (!row) return null;
    try {
      const ivs = row.iv.split(':');
      const tags = row.tag.split(':');
      const accessKey = CryptoUtil.decrypt(row.access_key_enc, ivs[0], tags[0]);
      const secretKey = CryptoUtil.decrypt(row.secret_key_enc, ivs[1], tags[1]);
      return { accessKey, secretKey };
    } catch (e) {
      return null;
    }
  }

  // API 키 삭제
  delete(userId, exchange) {
    this.db.deleteApiKey(userId, exchange);
  }

  // 마스킹된 키 반환 (GUI 표시용)
  getMasked(userId, exchange) {
    const keys = this.get(userId, exchange);
    if (!keys) return null;
    return {
      accessKey: keys.accessKey.slice(0, 8) + '****' + keys.accessKey.slice(-4),
      secretKey: '****' + keys.secretKey.slice(-4),
      exchange
    };
  }
}

module.exports = { AuthManager, CryptoUtil, ApiKeyManager, JWT_SECRET };
