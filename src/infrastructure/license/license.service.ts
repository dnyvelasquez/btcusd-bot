import fs from 'fs';
import path from 'path';

import postgres from 'postgres';

import { logger } from '@infra/logger/logger';
import { env } from '@config/env';
import { configService } from '@config/config-service';

const CACHE_PATH = path.resolve(__dirname, '..', '..', '..', 'license-cache.json');

interface LicenseRecord {
  owner_name: string;
  allowed_mode: 'demo' | 'live' | 'both';
  active: boolean;
  expires_at: string | null;
}

interface LicenseCache extends LicenseRecord {
  validated_at: string;
}

export class LicenseService {
  private ownerName = '';

  get owner(): string { return this.ownerName; }

  async validate(tradeMode: 'DEMO' | 'REAL'): Promise<void> {
    const licenseKey = configService.licenseKey;

    if (!env.DATABASE_URL || !licenseKey) {
      logger.warn('License validation skipped — DATABASE_URL / LICENSE_KEY not configured');
      return;
    }

    const sql = postgres(env.DATABASE_URL, { ssl: 'require', max: 1, connect_timeout: 5 });

    try {
      const rows = await sql<LicenseRecord[]>`
        SELECT owner_name, allowed_mode, active, expires_at
        FROM licenses
        WHERE license_key = ${licenseKey}::uuid
        LIMIT 1
      `;

      if (!rows.length) throw new Error('License key not found');

      const license = rows[0];

      if (!license.active) throw new Error('License is inactive');
      if (license.expires_at && new Date(license.expires_at) < new Date())
        throw new Error(`License expired on ${license.expires_at}`);

      this.validateMode(license.allowed_mode, tradeMode);

      this.ownerName = license.owner_name;
      logger.info({ owner: license.owner_name, mode: license.allowed_mode }, 'License valid');

      this.writeCache(license, tradeMode);
    } catch (err: unknown) {
      if (this.isConnectionError(err)) {
        logger.warn('DB unreachable — falling back to license cache');
        this.validateFromCache(tradeMode);
        return;
      }
      throw err;
    } finally {
      await sql.end({ timeout: 3 });
    }
  }

  private validateMode(allowed: 'demo' | 'live' | 'both', tradeMode: 'DEMO' | 'REAL'): void {
    if (allowed === 'both') return;
    if (allowed === 'demo' && tradeMode !== 'DEMO') throw new Error('License only allows demo');
    if (allowed === 'live' && tradeMode !== 'REAL') throw new Error('License only allows live');
  }

  private isConnectionError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message.toLowerCase();
    return msg.includes('timeout') || msg.includes('connect') || msg.includes('econnrefused') || msg.includes('enotfound');
  }

  private validateFromCache(tradeMode: 'DEMO' | 'REAL'): void {
    if (!fs.existsSync(CACHE_PATH)) throw new Error('No license cache found');
    const cached: LicenseCache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
    if (!cached.active) throw new Error('License is inactive');
    if (cached.expires_at && new Date(cached.expires_at) < new Date())
      throw new Error(`License expired on ${cached.expires_at}`);
    this.validateMode(cached.allowed_mode, tradeMode);
    this.ownerName = cached.owner_name;
    logger.warn({ owner: cached.owner_name }, 'License validated from cache');
  }

  private writeCache(license: LicenseRecord, tradeMode: string): void {
    try {
      fs.writeFileSync(CACHE_PATH, JSON.stringify({
        ...license, trade_mode: tradeMode, validated_at: new Date().toISOString(),
      }, null, 2));
    } catch {}
  }
}
