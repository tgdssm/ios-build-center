import fs from 'node:fs';
import path from 'node:path';
import { stdin, stdout } from 'node:process';
import { hashCode } from './auth.js';
import { gerarSegredo, uriOtpauth } from './totp.js';
import { ROOT } from './config.js';

const argv = process.argv.slice(2);
const role = argv.includes('--owner') ? 'owner' : 'dev';
const printOnly = argv.includes('--print');
const configPath = process.env.BUILD_CENTER_CONFIG || path.join(ROOT, 'config.json');

// Um leitor so para as duas perguntas. Nao da para misturar readline com modo raw
// na mesma stdin: o readline le adiantado, engole o resto da entrada e a pergunta
// seguinte fica esperando para sempre — foi o que aconteceu no primeiro teste.
// Aqui ha um listener unico, um buffer unico e uma fila de linhas prontas, o que
// tambem faz o script funcionar com a entrada vindo de um pipe.
const tty = Boolean(stdin.isTTY);
const lines = [];
let buffer = '';
let waiting = null;

const deliver = () => {
  if (!waiting || !lines.length) return;
  const { resolve } = waiting;
  waiting = null;
  stdout.write('\n');
  resolve(lines.shift());
};

stdin.setEncoding('utf8');
if (tty) stdin.setRawMode(true);
stdin.resume();
stdin.on('data', (chunk) => {
  for (const ch of chunk) {
    if (ch === '\u0003') finish(130); // Ctrl-C: o modo raw nao entrega SIGINT sozinho
    else if (ch === '\r' || ch === '\n') {
      lines.push(buffer);
      buffer = '';
      deliver();
    } else if (ch === '\u007f' || ch === '\b') {
      if (buffer) {
        buffer = buffer.slice(0, -1);
        if (tty && waiting && !waiting.hidden) stdout.write('\b \b');
      }
    } else if (ch >= ' ') {
      buffer += ch;
      if (tty && waiting && !waiting.hidden) stdout.write(ch);
    }
  }
});

function ask(prompt, hidden = false) {
  stdout.write(prompt);
  return new Promise((resolve) => {
    waiting = { resolve, hidden };
    deliver();
  });
}

function finish(code = 0) {
  if (tty) stdin.setRawMode(false);
  stdin.pause();
  process.exit(code);
}

function abort(message) {
  console.error(message);
  finish(1);
}

const name = (await ask(`Nome do usuario ${role === 'owner' ? '(voce)' : '(aparece na auditoria)'}: `)).trim();

if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$/.test(name)) {
  abort('Nome invalido: letras, numeros, ponto, hifen ou underscore; 2 a 32 caracteres.');
}

const code = await ask('Codigo de acesso (minimo 12 caracteres, nao aparece): ', true);
if (code.length < 12) {
  abort('Codigo curto demais. Minimo 12 caracteres.');
}
const again = await ask('Repita o codigo: ', true);
if (code !== again) {
  abort('Os dois codigos nao sao iguais. Nada foi gravado.');
}

const { salt, hash } = hashCode(code);
// Segundo fator sempre, sem pergunta. Um flag --sem-2fa so existiria para ser usado
// com pressa no dia errado, e a conta que ficasse sem ele seria exatamente a que
// alguem acharia primeiro. Quem nao quiser 2FA apaga o campo do config a mao e
// assume isso por escrito.
const totpSecret = gerarSegredo();
const entry = { name, role, salt, hash, totpSecret };

if (printOnly || !fs.existsSync(configPath)) {
  if (!printOnly) console.error(`${configPath} nao existe; imprimindo o bloco.`);
  console.log('\nAdicione em config.json, dentro de "users":\n');
  console.log(JSON.stringify(entry, null, 2));
  finish(0);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
config.users = Array.isArray(config.users) ? config.users : [];
const existing = config.users.findIndex((u) => u.name === name);
if (existing >= 0) config.users[existing] = entry;
else config.users.push(entry);

// Grava por arquivo temporario + rename: o config nunca fica pela metade, e o modo
// 600 e aplicado antes de ele virar o arquivo valido.
const tmp = `${configPath}.new`;
fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(tmp, configPath);

console.log(`\n${existing >= 0 ? 'Atualizado' : 'Criado'}: ${name} (${role}) em ${configPath}`);
console.log('\n--- segundo fator: cadastre AGORA, este segredo nao se repete ---');
console.log(`Segredo (digitar no app):  ${totpSecret}`);
console.log(`URI (colar no app):        ${uriOtpauth(name, totpSecret)}`);
console.log('Google Authenticator, 1Password, Authy, Bitwarden — qualquer um serve.');
console.log('Confira que o app mostra 6 digitos antes de fechar este terminal.');
console.log('\nReinicie o agent para valer:  launchctl kickstart -k gui/$(id -u)/com.buildcenter.agent');
finish(0);
