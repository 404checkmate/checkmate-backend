import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * 전역 `SupabaseJwtGuard`를 건너뛰고 싶은 엔드포인트에 부착한다.
 * 예: 헬스체크, 공개 마스터 데이터 조회.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
