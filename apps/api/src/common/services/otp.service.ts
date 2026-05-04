import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { Resend } from 'resend';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { prisma } from '@repo/db';
import { randomInt, createHash } from 'crypto';

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * OtpService — Secure email verification via Resend + Supabase Admin API.
 *
 * Security model:
 *   - OTP codes are stored as SHA-256 hashes — plaintext never persists in the DB.
 *   - Each send() invalidates all prior unused codes for the email address.
 *   - Codes expire after 10 minutes and are single-use (marked used on verify).
 *   - Supabase user is created with email_confirm: true — bypasses Supabase email.
 */
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

  private hashCode(code: string): string {
    return createHash('sha256').update(code).digest('hex');
  }

  async send(email: string): Promise<void> {
    // Invalidate all prior unused codes for this address
    await prisma.otpCode.updateMany({
      where: { email, used: false },
      data: { used: true },
    });

    // Generate 6-digit code (100000–999999 inclusive)
    const code = String(randomInt(100000, 999999));
    const codeHash = this.hashCode(code);

    await prisma.otpCode.create({
      data: {
        email,
        code: codeHash, // store hash, never plaintext
        expiresAt: new Date(Date.now() + OTP_TTL_MS),
      },
    });

    const { error } = await this.resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL!,
      to: email,
      subject: 'Your Numeriqu verification code',
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 32px; background: #050508; color: #F8FAFC; border-radius: 16px; border: 1px solid rgba(255,255,255,0.08);">
          <div style="margin-bottom: 32px;">
            <div style="width: 36px; height: 36px; background: #2563EB; border-radius: 8px; display: flex; align-items: center; justify-content: center; margin-bottom: 20px;">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="white"><path d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z"/></svg>
            </div>
            <h1 style="margin: 0 0 8px; font-size: 20px; font-weight: 700; color: #F8FAFC;">Verify your email</h1>
            <p style="margin: 0; color: #94A3B8; font-size: 14px; line-height: 1.6;">Enter this code to complete your Numeriqu account setup. It expires in 10 minutes.</p>
          </div>
          <div style="font-size: 44px; font-weight: 800; letter-spacing: 16px; color: #3B82F6; padding: 28px 24px; background: #0F0F1A; border: 1px solid rgba(37,99,235,0.3); border-radius: 12px; text-align: center; font-family: 'JetBrains Mono', 'Menlo', monospace;">
            ${code}
          </div>
          <p style="margin: 24px 0 0; font-size: 12px; color: #475569; line-height: 1.6;">If you didn't request this, you can safely ignore this email. This code will expire automatically.</p>
        </div>
      `,
    });

    if (error) {
      this.logger.error(`[OTP] Resend failed for ${email}: ${JSON.stringify(error)}`);
      throw new BadRequestException(
        'Failed to send verification email. Please check your email address and try again.',
      );
    }

    this.logger.log(`[OTP] Verification code dispatched to ${email}`);
  }

  async verify(email: string, code: string): Promise<void> {
    const codeHash = this.hashCode(code);

    const record = await prisma.otpCode.findFirst({
      where: { email, code: codeHash, used: false },
      orderBy: { createdAt: 'desc' },
    });

    if (!record) {
      throw new BadRequestException('Invalid verification code. Please check and try again.');
    }

    if (new Date() > record.expiresAt) {
      await prisma.otpCode.update({ where: { id: record.id }, data: { used: true } });
      throw new BadRequestException('This code has expired. Request a new verification code.');
    }

    // Mark as used — single-use enforcement
    await prisma.otpCode.update({ where: { id: record.id }, data: { used: true } });

    this.logger.log(`[OTP] Verified successfully for ${email}`);
  }

  async createVerifiedUser(
    email: string,
    password: string,
    name?: string,
  ): Promise<void> {
    const { error } = await this.supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // bypass Supabase email confirmation
      user_metadata: name ? { full_name: name } : {},
    });

    if (error) {
      if (error.message.toLowerCase().includes('already registered')) {
        throw new BadRequestException('An account with this email already exists. Please sign in.');
      }
      this.logger.error(`[OTP] Supabase createUser failed: ${error.message}`);
      throw new BadRequestException('Account creation failed. Please try again.');
    }

    this.logger.log(`[OTP] Supabase user created (email confirmed): ${email}`);
  }
}
