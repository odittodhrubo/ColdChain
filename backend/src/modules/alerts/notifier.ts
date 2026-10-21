import nodemailer from 'nodemailer';
import type { Config } from '../../config';
import { logger } from '../../shared/logger';

// Notification channels (P12). In-app (Socket.IO) is the primary channel and always on; Telegram and email are
// best-effort add-ons, skipped when not configured. Every send has a timeout and 3 tries with backoff, runs in
// the background and never throws: a notification problem must never block data ingestion.

export interface AlertMessage {
  title: string; // "Door open > 60 s"
  lines: string[]; // fridge, temperature, duration, ...
  link?: string; // deep link into the dashboard
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
}

export type ChannelResult = {
  status: 'sent' | 'failed' | 'skipped';
  attempts: number;
  at: number;
  error?: string;
};

type Fetch = typeof fetch;
type Mailer = { sendMail(m: { from: string; to: string; subject: string; text: string }): Promise<unknown> };

export interface NotifierDeps {
  fetch?: Fetch;
  mailer?: Mailer | null; // null = email off
  retryDelaysMs?: number[]; // waits before the 2nd and 3rd try
  timeoutMs?: number;
  getAlertEmail?: () => string | null;
}

/** Telegram legacy Markdown: escape the four markup characters in user data. */
const md = (s: string) => s.replace(/([_*`[])/g, '\\$1');

export function telegramText(m: AlertMessage): string {
  const icon = m.severity === 'CRITICAL' ? '🔴' : m.severity === 'WARNING' ? '🟠' : 'ℹ️';
  const body = [`${icon} *${md(m.title)}*`, ...m.lines.map(md)];
  if (m.link) body.push(`[Open dashboard](${m.link})`);
  return body.join('\n');
}

export class Notifier {
  private readonly fetch: Fetch;
  private readonly mailer: Mailer | null;
  private readonly delays: number[];
  private readonly timeoutMs: number;
  private readonly deps: NotifierDeps;

  constructor(
    private readonly config: Config,
    deps: NotifierDeps = {},
  ) {
    this.deps = deps;
    this.fetch = deps.fetch ?? fetch;
    this.delays = deps.retryDelaysMs ?? [1000, 3000];
    this.timeoutMs = deps.timeoutMs ?? 10_000;
    this.mailer =
      deps.mailer !== undefined
        ? deps.mailer
        : config.SMTP_HOST
          ? nodemailer.createTransport({
              host: config.SMTP_HOST,
              port: config.SMTP_PORT ?? 587,
              secure: config.SMTP_PORT === 465,
              auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS } : undefined,
              connectionTimeout: this.timeoutMs,
              greetingTimeout: this.timeoutMs,
              socketTimeout: this.timeoutMs,
            })
          : null;
  }

  getActiveEmail(): string | null {
    return this.deps.getAlertEmail?.() || this.config.ALERT_EMAIL_TO || null;
  }

  get channels() {
    return {
      telegram: Boolean(this.config.TELEGRAM_BOT_TOKEN && this.config.TELEGRAM_CHAT_ID),
      email: this.mailer !== null && Boolean(this.getActiveEmail()),
    };
  }

  /** Sends on every configured external channel; resolves with each channel's outcome. */
  async send(m: AlertMessage): Promise<{ telegram: ChannelResult; email: ChannelResult }> {
    if (!this.channels.telegram && !this.channels.email)
      logger.warn(
        { alert: m.title, lines: m.lines },
        'ALERT (no Telegram/email configured: console fallback)',
      );
    const [telegram, email] = await Promise.all([
      this.channels.telegram ? this.retry('telegram', () => this.telegram(m)) : skipped(),
      this.channels.email ? this.retry('email', () => this.email(m)) : skipped(),
    ]);
    return { telegram, email };
  }

  async sendTestEmail(toEmail?: string): Promise<{ ok: boolean; recipient: string; error?: string }> {
    const to = toEmail || this.getActiveEmail();
    if (!to) {
      return { ok: false, recipient: '', error: 'No recipient email configured. Please add an alert email first.' };
    }
    if (!this.mailer) {
      return { ok: false, recipient: to, error: 'SMTP is not configured in .env (SMTP_HOST is missing)' };
    }
    try {
      await this.mailer.sendMail({
        from: this.config.SMTP_USER || 'coldchain@localhost',
        to,
        subject: '[ColdChain] Test Alert Notification',
        text: [
          'This is a test notification from your ColdChain Vaccine & Medicine Storage Monitor.',
          '',
          'Email alert delivery is working properly.',
          'You will receive real-time warnings if a door remains open for > 60 seconds, or if temperature breaches 2–8 °C.',
          '',
          `Timestamp: ${new Date().toISOString()}`,
        ].join('\n'),
      });
      return { ok: true, recipient: to };
    } catch (err) {
      return { ok: false, recipient: to, error: (err as Error).message };
    }
  }

  private async telegram(m: AlertMessage) {
    const res = await this.fetch(
      `https://api.telegram.org/bot${this.config.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.config.TELEGRAM_CHAT_ID,
          text: telegramText(m),
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );
    if (!res.ok) throw new Error(`telegram HTTP ${res.status}`); // never echo the URL: it holds the bot token
  }

  private async email(m: AlertMessage, targetEmail?: string) {
    const to = targetEmail || this.getActiveEmail();
    if (!to) throw new Error('No recipient configured for email alert');
    await this.mailer!.sendMail({
      from: this.config.SMTP_USER || 'coldchain@localhost',
      to,
      subject: `[ColdChain ${m.severity}] ${m.title}`,
      text: [...m.lines, ...(m.link ? ['', m.link] : [])].join('\n'),
    });
  }

  private async retry(channel: string, fn: () => Promise<void>): Promise<ChannelResult> {
    let error = '';
    for (let attempt = 1; attempt <= this.delays.length + 1; attempt++) {
      try {
        await fn();
        return { status: 'sent', attempts: attempt, at: Date.now() };
      } catch (err) {
        error = (err as Error).message.slice(0, 200);
        logger.warn({ channel, attempt, error }, 'alert notification failed');
        if (attempt <= this.delays.length) await new Promise((r) => setTimeout(r, this.delays[attempt - 1]));
      }
    }
    return { status: 'failed', attempts: this.delays.length + 1, at: Date.now(), error };
  }
}

const skipped = async (): Promise<ChannelResult> => ({ status: 'skipped', attempts: 0, at: Date.now() });
