'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { createMailer } = require('../lib/mailer');

function payload(overrides = {}) {
  return {
    to: 'client@example.com',
    name: 'Aïcha de Cotonou',
    code: '482913',
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    ...overrides
  };
}

test('captures verification messages locally and redacts the code by default', async () => {
  const seenBySink = [];
  const mailer = createMailer({
    env: { NODE_ENV: 'test', EMAIL_TRANSPORT: 'capture' },
    captureSink: message => seenBySink.push(message)
  });

  const result = await mailer.sendVerificationCode(payload());
  assert.equal(result.accepted, true);
  assert.equal(result.transport, 'capture');
  assert.equal(typeof result.messageId, 'string');
  assert.equal(mailer.getCapturedMessages().length, 1);
  assert.match(mailer.getCapturedMessages()[0].text, /\[code masqué\]/);
  assert.doesNotMatch(mailer.getCapturedMessages()[0].text, /482913/);
  assert.doesNotMatch(JSON.stringify(seenBySink), /482913/);
  assert.equal(mailer.getCapturedMessages({ includeCode: true })[0].code, '482913');
});

test('requires SMTP in production and never exposes the verification code in the failure', async () => {
  const mailer = createMailer({ env: { NODE_ENV: 'production' } });
  await assert.rejects(
    mailer.sendVerificationCode(payload()),
    error => error.code === 'EMAIL_NOT_CONFIGURED' && error.status === 503 && !error.message.includes('482913') && !String(error.stack).includes('482913')
  );
});

test('supports an injected gateway without returning message contents', async () => {
  let delivered;
  const mailer = createMailer({
    env: { NODE_ENV: 'test', EMAIL_TRANSPORT: 'smtp', MAIL_FROM: 'Comptoir <no-reply@example.com>' },
    transport: async message => { delivered = message; }
  });
  const result = await mailer.sendVerificationCode(payload());
  assert.equal(result.transport, 'smtp');
  assert.equal(delivered.to, 'client@example.com');
  assert.match(delivered.raw, /482913/);
  assert.doesNotMatch(JSON.stringify(result), /482913/);
});

test('rejects malformed verification data without echoing the code', async () => {
  const mailer = createMailer({ env: { NODE_ENV: 'test', EMAIL_TRANSPORT: 'capture' } });
  await assert.rejects(
    mailer.sendVerificationCode(payload({ code: 'code-482913' })),
    error => error.code === 'EMAIL_INPUT_INVALID' && !error.message.includes('482913')
  );
  await assert.rejects(
    mailer.sendVerificationCode(payload({ to: 'bad\r\n@example.com' })),
    error => error.code === 'EMAIL_INPUT_INVALID'
  );
});

test('delivers through a plain SMTP server with multiline EHLO responses', async t => {
  const received = [];
  let buffer = '';
  let dataMode = false;
  const server = net.createServer(socket => {
    socket.write('220 local.test ESMTP\r\n');
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      if (dataMode) {
        const end = buffer.indexOf('\r\n.\r\n');
        if (end < 0) return;
        received.push(buffer.slice(0, end));
        buffer = buffer.slice(end + '\r\n.\r\n'.length);
        dataMode = false;
        socket.write('250 2.0.0 queued\r\n');
      }
      while (!dataMode) {
        const end = buffer.indexOf('\r\n');
        if (end < 0) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const command = line.toUpperCase();
        if (command.startsWith('EHLO')) socket.write('250-local.test\r\n250-SIZE 100000\r\n250 HELP\r\n');
        else if (command.startsWith('MAIL FROM:')) socket.write('250 sender ok\r\n');
        else if (command.startsWith('RCPT TO:')) socket.write('250 recipient ok\r\n');
        else if (command === 'DATA') { dataMode = true; socket.write('354 end with <CRLF>.<CRLF>\r\n'); }
        else if (command === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); return; }
        else socket.write('250 ok\r\n');
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(() => resolve())));

  const port = server.address().port;
  const mailer = createMailer({
    env: {
      NODE_ENV: 'test', EMAIL_TRANSPORT: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port),
      SMTP_SECURE: 'false', SMTP_STARTTLS: 'false', MAIL_FROM: 'no-reply@example.com', SMTP_TIMEOUT_MS: '3000'
    }
  });
  const result = await mailer.sendVerificationCode(payload());
  assert.equal(result.accepted, true);
  assert.equal(received.length, 1);
  assert.match(received[0], /From: no-reply@example.com/);
  assert.match(received[0], /To: client@example.com/);
  assert.match(received[0], /482913/);
});

test('production requires encrypted SMTP before sending credentials or codes',async()=>{
  const mailer=createMailer({env:{NODE_ENV:'production',EMAIL_TRANSPORT:'smtp',SMTP_HOST:'mail.example.test',MAIL_FROM:'no-reply@example.test',SMTP_SECURE:'false',SMTP_STARTTLS:'false'}});
  await assert.rejects(mailer.sendVerificationCode(payload()),error=>error.code==='EMAIL_CONFIG_INVALID');
});
