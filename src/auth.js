import crypto from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

export function hashCode(code, salt = crypto.randomBytes(16).toString('hex')) {
  const key = crypto.scryptSync(code, salt, SCRYPT.keylen, SCRYPT).toString('hex');
  return { salt, hash: key };
}

export function verifyCode(code, salt, expected) {
  const { hash } = hashCode(code, salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export class Sessions {
  constructor(cfg) {
    this.cfg = cfg;
    // Rotating per-process key: a restart invalidates every cookie, which is fine here
    // and removes any long-lived secret from disk.
    this.key = crypto.randomBytes(32);
    this.attempts = new Map(); // ip -> {count, until}
    this.totpGastos = new Map(); // "nome:contador" -> expira em
  }

  // Um codigo TOTP vale 30s, e a janela de tolerancia aceita o passo vizinho: sem
  // guardar nada, o mesmo codigo entra duas vezes dentro desse intervalo. Anotamos
  // qual contador cada conta ja gastou, entao ver o codigo deixa de bastar para
  // quem esta olhando por cima do ombro ou lendo um proxy.
  totpUsado(nome, contador) {
    const agora = Date.now();
    for (const [chave, expira] of this.totpGastos) if (expira <= agora) this.totpGastos.delete(chave);
    return this.totpGastos.has(`${nome}:${contador}`);
  }

  marcarTotp(nome, contador) {
    // 120s cobre com folga a janela de 90s em que o codigo ainda seria aceito.
    this.totpGastos.set(`${nome}:${contador}`, Date.now() + 120_000);
  }

  // Takes the config's user object, not a name: the role travels inside the signed
  // cookie, so a request cannot claim one and the server never has to look the
  // caller up again. A tampered cookie fails the HMAC and is simply not a session.
  issue(user) {
    const payload = Buffer.from(
      JSON.stringify({
        u: user.name,
        r: user.role,
        exp: Date.now() + this.cfg.limits.sessionHours * 3600_000,
        csrf: crypto.randomBytes(16).toString('hex'),
      }),
    ).toString('base64url');
    const mac = crypto.createHmac('sha256', this.key).update(payload).digest('base64url');
    return { cookie: `${payload}.${mac}`, data: JSON.parse(Buffer.from(payload, 'base64url').toString()) };
  }

  verify(cookie) {
    if (!cookie || !cookie.includes('.')) return null;
    const [payload, mac] = cookie.split('.');
    const expected = crypto.createHmac('sha256', this.key).update(payload).digest('base64url');
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
      return data.exp > Date.now() ? data : null;
    } catch {
      return null;
    }
  }

  throttled(ip) {
    const entry = this.attempts.get(ip);
    return Boolean(entry && entry.count >= 5 && entry.until > Date.now());
  }

  recordFailure(ip) {
    const entry = this.attempts.get(ip) ?? { count: 0, until: 0 };
    entry.count += 1;
    entry.until = Date.now() + 15 * 60_000;
    this.attempts.set(ip, entry);
  }

  recordSuccess(ip) {
    this.attempts.delete(ip);
  }
}
