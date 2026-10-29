import crypto from 'node:crypto';

// TOTP (RFC 6238) escrito aqui em vez de vir de um pacote. Sao ~40 linhas de
// HMAC-SHA1 e base32, e a alternativa seria carregar uma dependencia nova numa
// maquina pessoal que compila codigo de branch nao revisado. Menos superficie.

const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PASSO_S = 30;
const DIGITOS = 6;
// Uma janela para cada lado. Relogio de celular erra alguns segundos, e exigir
// sincronia perfeita transforma 2FA em chamado de suporte. Duas janelas ja dariam
// 90s de validade por codigo, que e tempo demais para um codigo interceptado.
const JANELA = 1;

export function gerarSegredo() {
  // 20 bytes = 160 bits, o tamanho da RFC 4226. Todo app autenticador aceita.
  const bytes = crypto.randomBytes(20);
  let bits = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  let saida = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) saida += ALFABETO[parseInt(bits.slice(i, i + 5), 2)];
  return saida;
}

export function segredoValido(segredo) {
  return typeof segredo === 'string' && /^[A-Z2-7]{16,64}$/.test(segredo);
}

function decodificar(segredo) {
  let bits = '';
  for (const ch of segredo) {
    const idx = ALFABETO.indexOf(ch);
    if (idx < 0) throw new Error('segredo TOTP invalido');
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function codigoEm(segredo, contador) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(contador));
  const dig = crypto.createHmac('sha1', decodificar(segredo)).update(buf).digest();
  const off = dig[dig.length - 1] & 0x0f;
  const num = dig.readUInt32BE(off) & 0x7fffffff;
  return String(num % 10 ** DIGITOS).padStart(DIGITOS, '0');
}

// Devolve o CONTADOR que casou, nao true. Quem chama precisa dele para barrar
// reuso: dentro de 30s o mesmo codigo continua valido, entao sem guardar qual
// contador ja foi usado um codigo capturado serve uma segunda vez.
export function verificarTotp(segredo, informado, agora = Date.now()) {
  if (typeof informado !== 'string' || !/^[0-9]{6}$/.test(informado)) return null;
  const atual = Math.floor(agora / 1000 / PASSO_S);
  for (let d = -JANELA; d <= JANELA; d += 1) {
    const esperado = codigoEm(segredo, atual + d);
    const a = Buffer.from(esperado);
    const b = Buffer.from(informado);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return atual + d;
  }
  return null;
}

export function uriOtpauth(usuario, segredo, emissor = 'iOS Build Center') {
  const rotulo = encodeURIComponent(`${emissor}:${usuario}`);
  const params = new URLSearchParams({
    secret: segredo,
    issuer: emissor,
    algorithm: 'SHA1',
    digits: String(DIGITOS),
    period: String(PASSO_S),
  });
  return `otpauth://totp/${rotulo}?${params}`;
}
