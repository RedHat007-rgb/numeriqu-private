import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { Resend } from 'resend';

@Injectable()
export class ResendService {
  private readonly logger = new Logger(ResendService.name);
  private readonly resend: Resend;
  private readonly fromEmail: string;

  constructor() {
    const apiKey = process.env.RESEND_API_KEY;
    const fromEmail = process.env.RESEND_FROM_EMAIL;

    if (!apiKey) throw new Error('RESEND_API_KEY is required.');
    if (!fromEmail) throw new Error('RESEND_FROM_EMAIL is required.');

    this.resend = new Resend(apiKey);
    this.fromEmail = fromEmail;
  }

  async sendOtpEmail(email: string, otp: string) {
    const html = this.buildOtpTemplate(otp);
    const { error } = await this.resend.emails.send({
      from: this.fromEmail,
      to: email,
      subject: 'Your Numeriqu verification code',
      html,
    });

    if (error) {
      this.logger.error(`Failed to send OTP email to ${email}: ${JSON.stringify(error)}`);
      throw new InternalServerErrorException('Failed to send OTP email.');
    }
  }

  private buildOtpTemplate(otp: string) {
    return `
      <div style="font-family:Arial,sans-serif;background:#f7fafc;color:#0f172a;padding:24px;">
        <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:14px;padding:24px;border:1px solid #e2e8f0;">
          <h2 style="margin:0 0 8px;font-size:22px;">Verify your Numeriqu sign-in</h2>
          <p style="margin:0 0 18px;color:#475569;line-height:1.5;">
            Use this one-time code to continue. It expires in 5 minutes.
          </p>
          <div style="font-size:34px;letter-spacing:10px;font-weight:700;text-align:center;padding:16px;border-radius:10px;background:#eff6ff;color:#1d4ed8;">
            ${otp}
          </div>
          <p style="margin:18px 0 0;color:#64748b;font-size:12px;line-height:1.5;">
            If you did not request this, you can ignore this email.
          </p>
        </div>
      </div>
    `;
  }
}

