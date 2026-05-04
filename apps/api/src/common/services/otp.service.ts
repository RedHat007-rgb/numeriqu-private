import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { Resend } from 'resend';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { prisma } from '@repo/db';
import { randomInt } from 'crypto';

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);
  private readonly resend: Resend;
  private readonly supabaseAdmin: SupabaseClient;

  constructor() {
    this.resend = new Resend(process.env.RESEND_API_KEY);
    this.supabaseAdmin = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
  }

  async send(email: string): Promise<void> {
    // Invalidate all prior unused codes for this address
    await prisma.otpCode.updateMany({
      where: { email, used: false },
      data: { used: true },
    });

    const code = String(randomInt(100000, 999999));

    await prisma.otpCode.create({
      data: {
        email,
        code,
        expiresAt: new Date(Date.now() + OTP_TTL_MS),
      },
    });

    const { error } = await this.resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL!,
      to: email,
      subject: 'Your verification code',
      html: `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #0f172a; color: #e2e8f0; border-radius: 12px;">
          <h2 style="margin: 0 0 8px; font-size: 22px; color: #fff;">Verify your email</h2>
          <p style="margin: 0 0 24px; color: #94a3b8;">Enter this code to complete your signup. It expires in 10 minutes.</p>
          <div style="font-size: 40px; font-weight: 700; letter-spacing: 12px; color: #60a5fa; padding: 24px; background: #1e293b; border-radius: 8px; text-align: center;">
            ${code}
          </div>
          <p style="margin: 24px 0 0; font-size: 12px; color: #475569;">If you didn't request this, ignore this email.</p>
        </div>
      `,
    });

    if (error) {
      this.logger.error(`[OTP] Resend failed for ${email}: ${JSON.stringify(error)}`);
      throw new BadRequestException(
        'Failed to send verification email. Check RESEND_API_KEY and RESEND_FROM_EMAIL.',
      );
    }

    this.logger.log(`[OTP] Code dispatched to ${email}`);
  }

  async verify(email: string, code: string): Promise<void> {
    const record = await prisma.otpCode.findFirst({
      where: { email, code, used: false },
      orderBy: { createdAt: 'desc' },
    });

    if (!record) {
      throw new BadRequestException('Invalid verification code.');
    }

    if (new Date() > record.expiresAt) {
      await prisma.otpCode.update({ where: { id: record.id }, data: { used: true } });
      throw new BadRequestException('Code has expired. Request a new one.');
    }

    await prisma.otpCode.update({ where: { id: record.id }, data: { used: true } });
  }

  async createVerifiedUser(
    email: string,
    password: string,
    name?: string,
  ): Promise<{ supabaseId: string }> {
    const { data, error } = await this.supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: name ? { full_name: name } : {},
    });

    if (error) {
      if (error.message.toLowerCase().includes('already registered')) {
        throw new BadRequestException('An account with this email already exists.');
      }
      this.logger.error(`[OTP] Supabase createUser failed: ${error.message}`);
      throw new BadRequestException('Account creation failed. Please try again.');
    }

    this.logger.log(`[OTP] Supabase user created and verified: ${email}`);
    return { supabaseId: data.user.id };
  }
}
