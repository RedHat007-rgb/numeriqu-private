import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';

@Injectable()
export class CryptoService {
  private readonly algorithm = 'aes-256-gcm';
  private readonly key = crypto.pbkdf2Sync(
    process.env.ENCRYPTION_KEY || 'default-secret-fallback-key',
    'security-salt-for-robustness',
    100000, // Iterations
    32,     // Key length in bytes
    'sha512'
  );

  encrypt(text: string): string {
    if (!text) return '';
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(this.algorithm, this.key, iv);
    
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const authTag = cipher.getAuthTag().toString('hex');
    
    // Format: iv:authTag:encrypted
    return `${iv.toString('hex')}:${authTag}:${encrypted}`;
  }

  decrypt(encryptedData: string): string {
    if (!encryptedData || !encryptedData.includes(':')) {
      return encryptedData;
    }

    try {
      const [ivHex, authTagHex, encryptedText] = encryptedData.split(':');
      if (!ivHex || !authTagHex || !encryptedText) return encryptedData;

      const iv = Buffer.from(ivHex, 'hex');
      const authTag = Buffer.from(authTagHex, 'hex');
      
      const decipher = crypto.createDecipheriv(this.algorithm, this.key, iv);
      decipher.setAuthTag(authTag);
      
      let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      
      return decrypted;
    } catch (e) {
      console.warn('[Crypto] Decryption failed, returning raw string.');
      return encryptedData;
    }
  }

  encryptJson(data: any): string {
    return this.encrypt(JSON.stringify(data));
  }

  decryptJson(encryptedData: string): any {
    const raw = this.decrypt(encryptedData);
    try {
      return JSON.parse(raw);
    } catch (e) {
      return {};
    }
  }
}
