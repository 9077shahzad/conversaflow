import nodemailer from 'nodemailer';

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: OutgoingMail): Promise<void>;
}

/** Local development: delivers to Mailpit (docker-compose) or any SMTP catcher. Never a real inbox. */
export class SmtpMailer implements Mailer {
  private readonly transport;
  constructor(url: string, private readonly from = 'ConversaFlow <no-reply@localhost>') {
    this.transport = nodemailer.createTransport(url);
  }
  async send(mail: OutgoingMail): Promise<void> {
    await this.transport.sendMail({ from: this.from, ...mail });
  }
}

/** Tests and environments without email: keeps messages in memory. */
export class MemoryMailer implements Mailer {
  readonly sent: OutgoingMail[] = [];
  async send(mail: OutgoingMail): Promise<void> {
    this.sent.push(mail);
  }
  lastTo(to: string): OutgoingMail | undefined {
    return [...this.sent].reverse().find((m) => m.to === to);
  }
}
