'use strict';

/*
 * Verification-mail delivery for the HTTP application.
 *
 * The application deliberately does not depend on a mail vendor SDK.  In a
 * local development/test process messages are captured in memory.  A
 * production process must opt into SMTP explicitly; this keeps a deployment
 * with a missing mail configuration from pretending that an account was
 * verified.
 *
 * Environment variables used by the built-in transport:
 *   EMAIL_TRANSPORT=capture|smtp   (default: capture outside production)
 *   SMTP_HOST, SMTP_PORT           (587 by default, 465 with SMTP_SECURE)
 *   SMTP_SECURE=true|false         (implicit TLS; STARTTLS is used otherwise)
 *   SMTP_STARTTLS=true|false       (default true for a non-secure connection)
 *   SMTP_USER, SMTP_PASSWORD       (set both to authenticate, or neither)
 *   MAIL_FROM                      (RFC 5322 address, required for SMTP)
 *   SMTP_TIMEOUT_MS                (default 15 seconds)
 *
 * Do not put verification codes in application logs.  Captured messages can
 * be inspected by tests with includeCode:true; the public/default view is
 * redacted.  The production SMTP path never returns the message body.
 */

const net = require('node:net');
const tls = require('node:tls');
const { randomUUID } = require('node:crypto');

const EMAIL = /^[^\s@<>\r\n]+@[^\s@<>\r\n]+\.[^\s@<>\r\n]+$/;
const CODE = /^\d{4,12}$/;
const MAX_NAME = 160;
const MAX_CODE = 12;
const MAX_EXPIRES = 32;
const DEFAULT_TIMEOUT = 15_000;
const MAX_CAPTURED = 100;

class MailerError extends Error {
  constructor(message, code = 'EMAIL_DELIVERY_FAILED', status = 503, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'MailerError';
    this.code = code;
    this.status = status;
  }
}

function fail(message, code, status, cause) {
  throw new MailerError(message, code, status, cause);
}

function isProduction(env) {
  return String(env.NODE_ENV || '').toLowerCase() === 'production';
}

function readBoolean(value, fallback) {
  if (value == null || value === '') return fallback;
  if (value === true || value === 'true' || value === '1' || value === 'yes') return true;
  if (value === false || value === 'false' || value === '0' || value === 'no') return false;
  fail('La configuration du transport e-mail est invalide.', 'EMAIL_CONFIG_INVALID', 500);
}

function readPort(value, secure) {
  if (value == null || value === '') return secure ? 465 : 587;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('La configuration SMTP est invalide.', 'EMAIL_CONFIG_INVALID', 500);
  return port;
}

function cleanHeader(value, label) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)) {
    fail(`L’adresse ${label} est invalide.`, 'EMAIL_CONFIG_INVALID', 500);
  }
  return value.trim();
}

function parseAddress(value, label) {
  const raw = cleanHeader(value, label);
  const match = raw.match(/^(?:([^<>\r\n]+?)\s*)?<([^<>\r\n]+)>$/) || raw.match(/^([^<>\r\n]+)$/);
  const address = (match?.[2] || match?.[1] || '').trim();
  if (!EMAIL.test(address)) fail(`L’adresse ${label} est invalide.`, 'EMAIL_CONFIG_INVALID', 500);
  return { header: raw, address };
}

function validatePayload(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Les informations de vérification sont invalides.', 'EMAIL_INPUT_INVALID', 400);
  const to = typeof input.to === 'string' ? input.to.trim().toLowerCase() : '';
  if (!EMAIL.test(to) || to.length > 254) fail('L’adresse e-mail est invalide.', 'EMAIL_INPUT_INVALID', 400);
  const name = input.name == null ? '' : String(input.name).trim();
  if (name.length > MAX_NAME || /[\r\n]/.test(name)) fail('Le nom est invalide.', 'EMAIL_INPUT_INVALID', 400);
  const code = typeof input.code === 'string' ? input.code : String(input.code ?? '');
  if (!CODE.test(code) || code.length > MAX_CODE) fail('Le code de vérification est invalide.', 'EMAIL_INPUT_INVALID', 400);
  const expires = input.expiresAt instanceof Date ? input.expiresAt : new Date(input.expiresAt);
  if (!Number.isFinite(expires.getTime()) || expires.getTime() <= Date.now() || expires.toISOString().length > MAX_EXPIRES) {
    fail('La date d’expiration est invalide.', 'EMAIL_INPUT_INVALID', 400);
  }
  return { to, name, code, expiresAt: expires.toISOString() };
}

function smtpConfig(env) {
  const secure = readBoolean(env.SMTP_SECURE, false);
  const host = typeof env.SMTP_HOST === 'string' ? env.SMTP_HOST.trim() : '';
  if (!host || /[\s\r\n]/.test(host) || host.length > 255) fail('La configuration SMTP est incomplète.', 'EMAIL_NOT_CONFIGURED', 503);
  if (typeof env.MAIL_FROM !== 'string' || !env.MAIL_FROM.trim()) fail('La configuration SMTP est incomplète.', 'EMAIL_NOT_CONFIGURED', 503);
  const from = parseAddress(env.MAIL_FROM, 'd’expédition');
  const user = env.SMTP_USER == null ? '' : String(env.SMTP_USER);
  const password = env.SMTP_PASSWORD == null ? '' : String(env.SMTP_PASSWORD);
  if ((user && !password) || (!user && password)) fail('La configuration SMTP est incomplète.', 'EMAIL_CONFIG_INVALID', 500);
  const starttls = readBoolean(env.SMTP_STARTTLS, !secure);
  if (isProduction(env) && !secure && !starttls) fail('Le transport SMTP de production doit utiliser TLS.','EMAIL_CONFIG_INVALID',500);
  if (secure && starttls) {
    // STARTTLS is meaningless after an implicit TLS handshake.  Treat this
    // as a safe configuration correction instead of trying two handshakes.
    return { host, port: readPort(env.SMTP_PORT, true), secure: true, starttls: false, user, password, from, timeoutMs: timeout(env) };
  }
  return { host, port: readPort(env.SMTP_PORT, secure), secure, starttls, user, password, from, timeoutMs: timeout(env) };
}

function timeout(env) {
  const value = env.SMTP_TIMEOUT_MS == null || env.SMTP_TIMEOUT_MS === '' ? DEFAULT_TIMEOUT : Number(env.SMTP_TIMEOUT_MS);
  if (!Number.isInteger(value) || value < 1000 || value > 120_000) fail('Le délai SMTP est invalide.', 'EMAIL_CONFIG_INVALID', 500);
  return value;
}

function resolveMode(env) {
  const mode = String(env.EMAIL_TRANSPORT || env.MAILER_TRANSPORT || (isProduction(env) ? 'smtp' : 'capture')).trim().toLowerCase();
  if (!['capture', 'smtp'].includes(mode)) fail('Le transport e-mail est invalide.', 'EMAIL_CONFIG_INVALID', 500);
  return mode;
}

function redactCode(text, code) {
  if (!code || typeof text !== 'string') return text;
  return text.split(code).join('[code masqué]');
}

function encodeSubject(subject) {
  return `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
}

function messageText({ name, code, expiresAt }) {
  const greeting = name ? `Bonjour ${name},` : 'Bonjour,';
  return `${greeting}\n\nVotre code de vérification Comptoir est : ${code}\n\nCe code expire le ${expiresAt}. Si vous n’êtes pas à l’origine de cette demande, vous pouvez ignorer ce message.\n\nL’équipe Comptoir`;
}

function buildMessage(payload, from) {
  const subject = 'Votre code de vérification Comptoir';
  const text = messageText(payload);
  // The envelope address is validated separately.  Header values are either
  // generated here or passed through cleanHeader/parseAddress above.
  return {
    id: randomUUID(),
    to: payload.to,
    from: from.address,
    fromHeader: from.header,
    subject,
    text,
    code: payload.code,
    expiresAt: payload.expiresAt,
    name: payload.name,
    raw: [
      `From: ${from.header}`,
      `To: ${payload.to}`,
      `Subject: ${encodeSubject(subject)}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${randomUUID()}@comptoir.local>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      text,
      ''
    ].join('\r\n')
  };
}

function safeCaptured(message, includeCode = false) {
  const result = {
    id: message.id,
    to: message.to,
    from: message.from,
    subject: message.subject,
    expiresAt: message.expiresAt,
    name: message.name,
    text: includeCode ? message.text : redactCode(message.text, message.code)
  };
  if (includeCode) result.code = message.code;
  return result;
}

class SmtpConnection {
  constructor(config) {
    this.config = config;
    this.socket = null;
    this.buffer = '';
    this.waiting = null;
    this.onData = data => this.receive(data);
    this.onError = error => this.fail(error);
    this.onClose = () => this.fail(new Error('Connexion SMTP interrompue.'));
    this.timer = null;
  }

  async open() {
    const { host, port, secure } = this.config;
    const socket = secure
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: true })
      : net.connect({ host, port });
    this.attach(socket);
    await new Promise((resolve, reject) => {
      const event = secure ? 'secureConnect' : 'connect';
      const deadline=setTimeout(()=>{socket.off(event,ready);socket.off('error',readyError);socket.destroy();reject(new Error('Délai SMTP dépassé.'));},this.config.timeoutMs);
      const ready = () => { clearTimeout(deadline);socket.off('error', readyError); resolve(); };
      const readyError = error => { clearTimeout(deadline);socket.off(event, ready); reject(error); };
      socket.once(event, ready);
      socket.once('error', readyError);
    });
    await this.command('');
    await this.ehlo();
    if (!secure && this.config.starttls) {
      if (!this.capabilities.has('STARTTLS')) throw new Error('Le serveur SMTP ne propose pas STARTTLS.');
      await this.command('STARTTLS', 220);
      await this.upgrade();
      await this.ehlo();
    }
    if (this.config.user) await this.authenticate();
  }

  attach(socket) {
    this.socket = socket;
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
    socket.setTimeout(this.config.timeoutMs, () => this.fail(new Error('Délai SMTP dépassé.')));
  }

  detach(socket) {
    socket.off('data', this.onData);
    socket.off('error', this.onError);
    socket.off('close', this.onClose);
    socket.setTimeout(0);
  }

  receive(chunk) {
    this.buffer += chunk.toString('utf8');
    if (!this.waiting) return;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || '';
    for (const line of lines) {
      const match = line.match(/^(\d{3})([ -])(.*)$/);
      if (!match) continue;
      if (this.waiting?.lines) this.waiting.lines.push({ code: Number(match[1]), text: match[3] });
      if (match[2] === '-') continue;
      const waiting = this.waiting;
      this.waiting = null;
      clearTimeout(this.timer);
      waiting.resolve({ code: Number(match[1]), text: match[3], lines: waiting.lines });
      break;
    }
  }

  fail(error) {
    if (!this.waiting) return;
    const waiting = this.waiting;
    this.waiting = null;
    clearTimeout(this.timer);
    waiting.reject(error);
  }

  command(line, expected) {
    return new Promise((resolve, reject) => {
      if (this.waiting) return reject(new Error('Commande SMTP simultanée.'));
      this.waiting = { lines: [], resolve: result => {
        const ok = result.code >= 200 && result.code < 400 && (expected == null || result.code === expected);
        if (!ok) return reject(new Error(`Réponse SMTP inattendue (${result.code}).`));
        resolve(result);
      }, reject };
      this.timer = setTimeout(() => this.fail(new Error('Délai SMTP dépassé.')), this.config.timeoutMs);
      if (line) this.socket.write(`${line}\r\n`);
      else if (this.buffer) this.receive(Buffer.alloc(0));
    });
  }

  async ehlo() {
    const response = await this.command(`EHLO comptoir.local`, 250);
    this.capabilities = new Set(response.lines.map(line => line.text.toUpperCase()));
    return response;
  }

  async upgrade() {
    const old = this.socket;
    this.detach(old);
    const secure = tls.connect({ socket: old, servername: this.config.host, rejectUnauthorized: true });
    this.attach(secure);
    await new Promise((resolve, reject) => {
      const deadline=setTimeout(()=>{secure.off('secureConnect',ready);secure.off('error',failed);secure.destroy();reject(new Error('Délai SMTP dépassé.'));},this.config.timeoutMs);
      const ready = () => { clearTimeout(deadline);secure.off('error', failed); resolve(); };
      const failed = error => { clearTimeout(deadline);secure.off('secureConnect', ready); reject(error); };
      secure.once('secureConnect', ready);
      secure.once('error', failed);
    });
  }

  async authenticate() {
    const auth = await this.command('AUTH LOGIN');
    if (![334, 235].includes(auth.code)) throw new Error('Authentification SMTP refusée.');
    if (auth.code === 235) return;
    await this.command(Buffer.from(this.config.user).toString('base64'), 334);
    await this.command(Buffer.from(this.config.password).toString('base64'), 235);
  }

  async send(message) {
    await this.open();
    await this.command(`MAIL FROM:<${message.from}>`, 250);
    await this.command(`RCPT TO:<${message.to}>`, 250);
    await this.command('DATA', 354);
    const body = message.raw.replace(/\r?\n/g,'\r\n').replace(/^\./gm, '..');
    await this.command(`${body}\r\n.`, 250);
    await this.command('QUIT');
    this.socket.end();
  }

  close() {
    clearTimeout(this.timer);
    if (this.socket && !this.socket.destroyed) this.socket.destroy();
  }
}

async function smtpTransport(message, config) {
  const connection = new SmtpConnection(config);
  try {
    await connection.send(message);
  } catch (error) {
    connection.close();
    throw error;
  }
}

function createMailer(options = {}) {
  const env = options.env || process.env;
  const captured = [];
  const transport = options.transport;
  const captureSink = options.captureSink;

  function capture(message) {
    captured.push(message);
    while (captured.length > MAX_CAPTURED) captured.shift();
    // A sink is useful for tests and local tooling, but it receives a
    // redacted copy so accidental logging cannot reveal the verification code.
    if (typeof captureSink === 'function') captureSink(safeCaptured(message));
  }

  async function sendVerificationCode(input) {
    const payload = validatePayload(input);
    const mode = resolveMode(env);
    let message;
    if (mode === 'capture') {
      if (isProduction(env) && options.allowCapture !== true) fail('Le service d’e-mail n’est pas configuré.', 'EMAIL_NOT_CONFIGURED', 503);
      message = buildMessage(payload, parseAddress(env.MAIL_FROM || 'Comptoir <no-reply@comptoir.local>', 'd’expédition'));
      capture(message);
      return { accepted: true, transport: 'capture', messageId: message.id };
    }
    let config;
    try {
      // An injected transport is intentionally supported for tests and for a
      // host application's own mail gateway.  It still gets the same
      // validation and redaction guarantees as SMTP.
      config = typeof transport === 'function'
        ? { from: parseAddress(env.MAIL_FROM || 'Comptoir <no-reply@comptoir.local>', 'd’expédition') }
        : smtpConfig(env);
    }
    catch (error) {
      if (error.code === 'EMAIL_NOT_CONFIGURED') throw error;
      throw error;
    }
    message = buildMessage(payload, config.from);
    try {
      if (typeof transport === 'function') await transport({ ...message, raw: message.raw });
      else await smtpTransport(message, config);
      return { accepted: true, transport: 'smtp', messageId: message.id };
    } catch (error) {
      throw new MailerError('Le message de vérification n’a pas pu être envoyé.', 'EMAIL_DELIVERY_FAILED', 503, error);
    }
  }

  return {
    sendVerificationCode,
    getCapturedMessages(options = {}) { return captured.map(message => safeCaptured(message, options.includeCode === true)); },
    clearCapturedMessages() { captured.length = 0; }
  };
}

const defaultMailer = createMailer();

module.exports = {
  MailerError,
  createMailer,
  sendVerificationCode: defaultMailer.sendVerificationCode,
  getCapturedMessages: defaultMailer.getCapturedMessages,
  clearCapturedMessages: defaultMailer.clearCapturedMessages,
  redactCode,
  // Exported for focused protocol tests without making the server depend on
  // implementation details.
  _private: { validatePayload, parseAddress, buildMessage, SmtpConnection }
};
