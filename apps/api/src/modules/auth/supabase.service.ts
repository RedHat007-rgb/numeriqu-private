import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { PrismaClient } from '@repo/db';
import { createHash } from 'crypto';
import { Inject } from '@nestjs/common';
import { PRISMA_TOKEN } from '../../database/database.module';

type SessionResult = {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    email: string;
    name: string | null;
  };
  expiresIn: number;
};

@Injectable()
export class SupabaseService {
  private readonly logger = new Logger(SupabaseService.name);
  private readonly supabaseAdmin: SupabaseClient;
  private readonly passwordSeed: string;

  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
    this.passwordSeed = process.env.SUPABASE_INTERNAL_AUTH_SECRET || '';

    if (!supabaseUrl) throw new Error('SUPABASE_URL is required.');
    if (!serviceRoleKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required.');
    if (!this.passwordSeed) throw new Error('SUPABASE_INTERNAL_AUTH_SECRET is required.');

    this.supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }

  private normalizeEmail(email: string) {
    return email.trim().toLowerCase();
  }

  private servicePassword(email: string) {
    const digest = createHash('sha256')
      .update(`${this.passwordSeed}:${this.normalizeEmail(email)}`)
      .digest('hex');
    return `${digest}Aa1!`;
  }

  private defaultName(email: string) {
    const prefix = this.normalizeEmail(email).split('@')[0] || 'User';
    return prefix
      .replace(/[^a-zA-Z0-9]+/g, ' ')
      .trim()
      .slice(0, 60);
  }

  async createSessionForEmail(email: string): Promise<SessionResult> {
    const normalizedEmail = this.normalizeEmail(email);
    const password = this.servicePassword(normalizedEmail);

    let appUser = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true, email: true, fullName: true, supabaseUserId: true },
    });

    if (!appUser) {
      // Brand-new user — create in Supabase Auth first, then mirror in app DB
      const created = await this.supabaseAdmin.auth.admin.createUser({
        email: normalizedEmail,
        password,
        email_confirm: true,
      });
      if (created.error || !created.data.user) {
        this.logger.error(
          `Supabase user creation failed for ${normalizedEmail}: ${created.error?.message}`,
        );
        throw new InternalServerErrorException('Failed to create user session.');
      }

      appUser = await this.prisma.user.create({
        data: {
          supabaseUserId: created.data.user.id,
          email: normalizedEmail,
          fullName: this.defaultName(normalizedEmail),
          isVerified: true,
          isActive: true,
        },
        select: { id: true, email: true, fullName: true, supabaseUserId: true },
      });
    }

    // Try signing in with the password derived from the current secret
    const signIn = await this.supabaseAdmin.auth.signInWithPassword({
      email: normalizedEmail,
      password,
    });

    if (signIn.error || !signIn.data.session) {
      // Sign-in failed — this happens when SUPABASE_INTERNAL_AUTH_SECRET changed,
      // or when the Supabase Auth record doesn't exist yet for a legacy DB user.
      // Use supabaseUserId (the Supabase Auth UUID) — NOT appUser.id (the app DB UUID).
      const authUserId = appUser.supabaseUserId;

      // Check whether the Supabase Auth user actually exists
      const { data: existingAuthUser } = await this.supabaseAdmin.auth.admin.getUserById(authUserId);

      if (!existingAuthUser?.user) {
        // Supabase Auth record is missing (e.g. legacy row inserted directly in DB) — create it
        const recreated = await this.supabaseAdmin.auth.admin.createUser({
          email: normalizedEmail,
          password,
          email_confirm: true,
        });
        if (recreated.error || !recreated.data.user) {
          this.logger.error(
            `Supabase user re-creation failed for ${normalizedEmail}: ${recreated.error?.message}`,
          );
          throw new InternalServerErrorException('Failed to create user session.');
        }
        // Keep the supabaseUserId in sync with the newly created Supabase Auth user
        await this.prisma.user.update({
          where: { id: appUser.id },
          data: { supabaseUserId: recreated.data.user.id },
        });
        appUser = { ...appUser, supabaseUserId: recreated.data.user.id };
      } else {
        // User exists in Supabase Auth — just reset their password to the current derived value
        const syncPassword = await this.supabaseAdmin.auth.admin.updateUserById(authUserId, {
          password,
          email_confirm: true,
        });

        if (syncPassword.error) {
          this.logger.error(
            `Supabase password sync failed for ${normalizedEmail}: ${syncPassword.error.message}`,
          );
          throw new InternalServerErrorException('Failed to create user session.');
        }
      }

      const retrySignIn = await this.supabaseAdmin.auth.signInWithPassword({
        email: normalizedEmail,
        password,
      });

      if (retrySignIn.error || !retrySignIn.data.session) {
        this.logger.error(
          `Supabase sign-in failed for ${normalizedEmail}: ${retrySignIn.error?.message}`,
        );
        throw new InternalServerErrorException('Failed to create user session.');
      }

      return {
        accessToken: retrySignIn.data.session.access_token,
        refreshToken: retrySignIn.data.session.refresh_token,
        user: {
          id: appUser.id,
          email: appUser.email,
          name: appUser.fullName,
        },
        expiresIn: retrySignIn.data.session.expires_in,
      };
    }

    return {
      accessToken: signIn.data.session.access_token,
      refreshToken: signIn.data.session.refresh_token,
      user: {
        id: appUser.id,
        email: appUser.email,
        name: appUser.fullName,
      },
      expiresIn: signIn.data.session.expires_in,
    };
  }
}
