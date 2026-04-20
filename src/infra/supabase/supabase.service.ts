import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

/**
 * Supabase 어드민 클라이언트 래퍼.
 * JWT 검증은 `SupabaseJwtGuard`에서 수행하며, 이 서비스는
 * 관리자 권한이 필요한 작업(예: 사용자 초대, Storage 업로드 등)에만 사용한다.
 */
@Injectable()
export class SupabaseService {
  private readonly logger = new Logger(SupabaseService.name);
  private _admin: SupabaseClient | null = null;

  constructor(private readonly config: ConfigService) {}

  get admin(): SupabaseClient {
    if (this._admin) return this._admin;

    const url = this.config.get<string>('supabase.url');
    const serviceKey = this.config.get<string>('supabase.serviceRoleKey');

    if (!url || !serviceKey) {
      throw new Error('[supabase] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 설정되지 않았습니다.');
    }

    this._admin = createClient(url, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    this.logger.log('Supabase admin client initialized');
    return this._admin;
  }
}
