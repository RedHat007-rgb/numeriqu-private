import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { randomInt, randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { RedisService } from './redis.service';

const OTP_TTL_SECONDS = 5 * 60;
const MAX_RESEND_PER_HOUR = 5;
const MAX_VERIFY_ATTEMPTS = 5;

@Injectable()
export class OtpService {
  constructor(private readonly redisService: RedisService) {}

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  private otpKey(email: string) {
    return `otp:${this.normalizeEmail(email)}`;
  }

  private resendRateKey(email: string) {
    return `otp:rate:${this.normalizeEmail(email)}`;
  }

  private attemptsKey(email: string) {
    return `otp:attempts:${this.normalizeEmail(email)}`;
  }

  private hashOtp(otp: string, salt: Buffer): Buffer {
    return scryptSync(otp, salt, 32);
  }

  private serializeOtpPayload(otp: string): string {
    const salt = randomBytes(16);
    const hash = this.hashOtp(otp, salt);
    return JSON.stringify({
      salt: salt.toString('hex'),
      hash: hash.toString('hex'),
      issuedAt: Date.now(),
    });
  }

  generateOtp(): string {
    return String(randomInt(100000, 1000000));
  }

  async enforceResendRateLimit(email: string) {
    const key = this.resendRateKey(email);
    const count = await this.redisService.redis.incr(key);
    if (count === 1) {
      await this.redisService.redis.expire(key, 60 * 60);
    }
    if (count > MAX_RESEND_PER_HOUR) {
      throw new HttpException(
        'Too many OTP requests. Please try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  async storeOtp(email: string, otp: string) {
    const value = this.serializeOtpPayload(otp);
    await this.redisService.redis.set(this.otpKey(email), value, 'EX', OTP_TTL_SECONDS);
    await this.redisService.redis.del(this.attemptsKey(email));
  }

  async verifyOtp(email: string, candidateOtp: string) {
    const normalizedEmail = this.normalizeEmail(email);
    const attemptsKey = this.attemptsKey(normalizedEmail);
    const currentAttempts = Number((await this.redisService.redis.get(attemptsKey)) ?? 0);
    if (currentAttempts >= MAX_VERIFY_ATTEMPTS) {
      throw new HttpException(
        'Too many invalid attempts. Request a new OTP.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const payload = await this.redisService.redis.get(this.otpKey(normalizedEmail));
    if (!payload) {
      throw new BadRequestException('OTP expired or not found. Please request a new OTP.');
    }

    let parsed: { salt: string; hash: string };
    try {
      parsed = JSON.parse(payload) as { salt: string; hash: string };
    } catch {
      await this.redisService.redis.del(this.otpKey(normalizedEmail));
      throw new BadRequestException('OTP expired or invalid. Please request a new OTP.');
    }

    const salt = Buffer.from(parsed.salt, 'hex');
    const expectedHash = Buffer.from(parsed.hash, 'hex');
    const providedHash = this.hashOtp(candidateOtp, salt);

    const matches =
      expectedHash.length === providedHash.length &&
      timingSafeEqual(expectedHash, providedHash);

    if (!matches) {
      const attempts = await this.redisService.redis.incr(attemptsKey);
      if (attempts === 1) {
        await this.redisService.redis.expire(attemptsKey, OTP_TTL_SECONDS);
      }
      throw new BadRequestException('Invalid OTP.');
    }

    await this.redisService.redis.del(this.otpKey(normalizedEmail));
    await this.redisService.redis.del(attemptsKey);
  }
}
