import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { getConfig, isSmtpConfigured, publicConfig } from './config.js';

/** 把 UTF-8 字符串按 RFC 2047 编码，并做 75 字符以内的折行。 */
export function encodeHeaderValue(value) {
  const text = String(value ?? '');
  if (/^[\x20-\x7E]*$/.test(text)) return text;
  const bytes = Buffer.from(text, 'utf8');
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 45) {
    chunks.push(`=?UTF-8?B?${bytes.subarray(i, i + 45).toString('base64')}?=`);
  }
  return chunks.join('\r\n ');
}

function wrapBase64(buffer, width = 76) {
  const b64 = buffer.toString('base64');
  const lines = [];
  for (let i = 0; i < b64.length; i += width) lines.push(b64.slice(i, i + width));
  return lines.join('\r\n');
}

/** 组装一封完整的 RFC 5322 报文。收件人只出现在 RCPT TO，符合 Bcc 语义。 */
export function buildRawMessage({ from, fromName, toHeader, subject, html }) {
  const domain = String(from).split('@')[1] || 'localhost';
  const fromHeader = fromName ? `${encodeHeaderValue(fromName)} <${from}>` : `<${from}>`;
  const headers = [
    `From: ${fromHeader}`,
    `To: ${toHeader}`,
    `Subject: ${encodeHeaderValue(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    'X-Mailer: STAL',
  ];
  return `${headers.join('\r\n')}\r\n\r\n${wrapBase64(Buffer.from(html, 'utf8'))}`;
}

class SmtpClient {
  constructor({ host, port, secure = true, timeoutMs = 30000 }) {
    this.host = host;
    this.port = port;
    this.secure = secure;
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.buffer = '';
    this.waiters = [];
    this.pendingLines = [];
    this.closed = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const onError = (err) => reject(err);
      this.socket = this.secure
        ? tls.connect({ host: this.host, port: this.port, servername: this.host })
        : net.connect({ host: this.host, port: this.port });

      this.socket.setTimeout(this.timeoutMs);
      this.socket.on('data', (chunk) => this.onData(chunk));
      this.socket.on('timeout', () => this.destroy(new Error('SMTP 连接超时')));
      this.socket.on('error', (err) => this.fail(err));
      this.socket.on('close', () => this.fail(new Error('SMTP 连接已关闭')));

      const event = this.secure ? 'secureConnect' : 'connect';
      this.socket.once(event, resolve);
      this.socket.once('error', onError);
    });
  }

  fail(err) {
    this.closed = true;
    while (this.waiters.length) this.waiters.shift().reject(err);
  }

  destroy(err) {
    this.fail(err || new Error('SMTP 连接已销毁'));
    try {
      this.socket?.destroy();
    } catch {
      /* 忽略 */
    }
  }

  onData(chunk) {
    this.buffer += chunk.toString('utf8');
    let index;
    while ((index = this.buffer.indexOf('\r\n')) !== -1) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      this.pendingLines.push(line);
      // 形如 "250-..." 表示后面还有同一条响应的后续行
      if (line.length >= 4 && line[3] === '-') continue;
      const code = Number(line.slice(0, 3)) || 0;
      const lines = this.pendingLines.splice(0);
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve({ code, lines });
    }
  }

  readResponse(timeoutMs = this.timeoutMs) {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error('SMTP 连接不可用'));
        return;
      }
      const waiter = {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      const timer = setTimeout(() => {
        const pos = this.waiters.indexOf(waiter);
        if (pos >= 0) this.waiters.splice(pos, 1);
        reject(new Error('SMTP 响应超时'));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  /** label 用于错误信息：认证类命令不能把 base64 凭据回显到日志里。 */
  async exec(command, expectCodes, label = null) {
    if (command) this.socket.write(`${command}\r\n`);
    const res = await this.readResponse();
    if (expectCodes && !expectCodes.includes(res.code)) {
      const name = label || (command ? command.split(' ')[0] : 'greeting');
      throw new Error(`SMTP 命令被拒绝: ${name} -> ${res.lines.join(' ')}`);
    }
    return res;
  }

  async handshake(user, pass) {
    await this.exec(null, [220]);
    await this.exec('EHLO stal.local', [250]);
    await this.exec('AUTH LOGIN', [334], 'AUTH LOGIN');
    await this.exec(Buffer.from(user, 'utf8').toString('base64'), [334], 'AUTH <username>');
    await this.exec(Buffer.from(pass, 'utf8').toString('base64'), [235], 'AUTH <password>');
  }

  async sendRaw(from, recipients, raw) {
    await this.exec(`MAIL FROM:<${from}>`, [250]);
    const accepted = [];
    const rejected = [];
    for (const rcpt of recipients) {
      const res = await this.exec(`RCPT TO:<${rcpt}>`, [250, 251, 550, 551, 553]);
      if (res.code === 250 || res.code === 251) accepted.push(rcpt);
      else rejected.push(rcpt);
    }
    if (accepted.length === 0) {
      throw new Error(`所有收件人均被拒绝: ${rejected.join(', ')}`);
    }
    await this.exec('DATA', [354]);
    this.socket.write(`${raw}\r\n.\r\n`);
    const res = await this.readResponse();
    if (res.code !== 250) throw new Error(`邮件未被接受: ${res.lines.join(' ')}`);
    return { accepted, rejected, response: res.lines.join(' ') };
  }

  close() {
    try {
      if (this.socket && !this.closed) this.socket.write('QUIT\r\n');
    } catch {
      /* 忽略 */
    }
    try {
      this.socket?.end();
    } catch {
      /* 忽略 */
    }
    this.closed = true;
  }
}

export class MailSender {
  constructor(cfg = getConfig()) {
    this.cfg = cfg;
    this.client = null;
  }

  get account() {
    return String(this.cfg.smtp.user || '').trim();
  }

  headerMode() {
    return String(this.cfg.smtp.toHeaderMode || 'self');
  }

  toHeader() {
    if (this.headerMode() === 'undisclosed') return 'undisclosed-recipients:;';
    return `<${this.account}>`;
  }

  assertConfigured() {
    if (!isSmtpConfigured(this.cfg)) {
      throw new Error('SMTP 未配置：请在 config.json 的 smtp.user 中填写你的 QQ 邮箱地址，并在 smtp.pass 中填写授权码。');
    }
  }

  async ensureClient() {
    if (this.client && !this.client.closed) return this.client;
    this.assertConfigured();
    const client = new SmtpClient({
      host: this.cfg.smtp.host,
      port: this.cfg.smtp.port,
      secure: this.cfg.smtp.port === 465,
      timeoutMs: this.cfg.smtp.timeoutMs || 30000,
    });
    await client.connect();
    await client.handshake(this.account, String(this.cfg.smtp.pass || '').trim());
    this.client = client;
    return client;
  }

  dropClient() {
    this.client?.close();
    this.client = null;
  }

  async verify() {
    const client = await this.ensureClient();
    return { host: this.cfg.smtp.host, port: this.cfg.smtp.port, account: this.account, ok: Boolean(client) };
  }

  /**
   * 发送一封邮件：真正的收件人全部走 RCPT TO（Bcc），报文的 To 头写成发件人自己。
   */
  async send({ recipients, subject, html }) {
    const list = [...new Set((recipients || []).map((r) => String(r).trim()).filter(Boolean))];
    if (list.length === 0) throw new Error('收件人列表为空');

    const raw = buildRawMessage({
      from: this.account,
      fromName: this.cfg.smtp.fromName,
      toHeader: this.toHeader(),
      subject,
      html,
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const client = await this.ensureClient();
        const result = await client.sendRaw(this.account, list, raw);
        return { ...result, recipients: list, subject };
      } catch (err) {
        this.dropClient();
        if (attempt === 1) throw err;
      }
    }
    throw new Error('邮件发送失败');
  }
}

export function describeSmtp() {
  return publicConfig().smtp;
}
