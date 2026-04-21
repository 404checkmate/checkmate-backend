/* eslint-disable no-console */
/**
 * OpenAI API Key 및 LLM 연동 smoke 테스트
 *
 * 실행:
 *   npm run llm:test
 *
 * 동작:
 *   1. .env 의 LLM_API_KEY / LLM_MODEL 로드
 *   2. 샘플 TripContext 로 OpenaiService.recommendAdditionalItems() 호출
 *   3. JSON 파싱 성공 여부, 아이템 수, 토큰 사용량을 터미널에 출력
 *
 * DB/Supabase 불필요 — 순수 OpenAI 호출만 검증.
 */
import { ConfigService } from '@nestjs/config';
import { config as loadEnv } from 'dotenv';
import { OpenaiService, TripContext } from '../src/modules/llm/openai.service';

loadEnv();

function mask(key: string): string {
  if (!key) return '<empty>';
  if (key.length <= 10) return `${key.slice(0, 3)}***`;
  return `${key.slice(0, 7)}...${key.slice(-4)} (len=${key.length})`;
}

async function main() {
  const apiKey = process.env.LLM_API_KEY ?? '';
  const model = process.env.LLM_MODEL ?? 'gpt-4o-mini';

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(' OpenAI LLM Smoke Test');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(` model       : ${model}`);
  console.log(` provider    : ${process.env.LLM_PROVIDER ?? 'openai'}`);
  console.log(` api key     : ${mask(apiKey)}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (!apiKey) {
    console.error('\n[FAIL] LLM_API_KEY 가 비어 있습니다. .env 에 키를 저장한 뒤 다시 실행하세요.');
    process.exit(1);
  }

  // NestJS ConfigService 를 ConfigModule 부팅 없이 단독으로 구성.
  const config = new ConfigService({
    llm: { apiKey, model },
  });
  const service = new OpenaiService(config);

  const context: TripContext = {
    destination: '태국 (방콕)',
    durationDays: 5,
    season: '여름',
    companions: ['친구'],
    purposes: ['맛집 탐방', '쇼핑'],
  };
  console.log('[context]', JSON.stringify(context, null, 2));
  console.log('\n[call] OpenaiService.recommendAdditionalItems() ...');

  const startedAt = Date.now();
  try {
    const { items, usage } = await service.recommendAdditionalItems(context);
    const elapsedMs = Date.now() - startedAt;

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(' ✅ PASS');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(` model used   : ${usage.model}`);
    console.log(` tokens used  : ${usage.tokens}`);
    console.log(` elapsed      : ${elapsedMs} ms`);
    console.log(` items count  : ${items.length}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    if (!items.length) {
      console.warn('[WARN] items 가 0 개 반환되었습니다. 모델이 조건을 너무 엄격히 해석했을 수 있습니다.');
    }

    items.forEach((item, idx) => {
      console.log(
        `${String(idx + 1).padStart(2, '0')}. [${item.category}] ${item.title}` +
          (item.description ? `  — ${item.description}` : '') +
          `  (prep=${item.prep_type}, baggage=${item.baggage_type})`,
      );
    });

    console.log('\n[sanity] JSON 형태 OK, 카테고리/enum 화이트리스트 통과 확인 완료.');
    process.exit(0);
  } catch (e) {
    const err = e as Error & { status?: number; code?: string };
    console.error('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error(' ❌ FAIL');
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error(` message : ${err.message}`);
    if (err.status) console.error(` status  : ${err.status}`);
    if (err.code) console.error(` code    : ${err.code}`);
    console.error('\n[hint]');
    if (err.status === 401) {
      console.error(' - API Key 가 유효하지 않습니다. https://platform.openai.com/api-keys 에서 재발급.');
    } else if (err.status === 429) {
      console.error(' - Rate limit 또는 크레딧 부족. OpenAI 빌링/사용량 확인 필요.');
    } else if (err.status === 404) {
      console.error(` - 모델 "${model}" 에 접근 권한이 없습니다. LLM_MODEL 값을 확인하세요.`);
    } else if (err.message.includes('fetch')) {
      console.error(' - 네트워크 문제. 방화벽/프록시 설정 확인.');
    }
    process.exit(1);
  }
}

main();
