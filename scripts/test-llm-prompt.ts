/* eslint-disable no-console */
/**
 * LLM 프롬프트 품질 테스트 스크립트
 *
 * 실행:
 *   npx ts-node scripts/test-llm-prompt.ts
 *
 * .env 에서 LLM_API_KEY, LLM_MODEL 을 로드해 OpenAI API 를 직접 호출한다.
 * raw LLM 응답을 정규화 전에 검증해 프롬프트 품질을 확인한다.
 * NestJS DI 없이 독립 실행.
 */

import { ConfigService } from '@nestjs/config';
import { config as loadEnv } from 'dotenv';
import OpenAI from 'openai';
import { OpenaiService, TripContext } from '../src/modules/llm/openai.service';

loadEnv();

// ─── 상수 ────────────────────────────────────────────────────────────────────

const VALID_CATEGORIES = [
  'essentials',
  'clothing',
  'health',
  'toiletries',
  'beauty',
  'electronics',
  'travel_goods',
  'booking',
  'pre_departure',
] as const;

const VALID_PREP_TYPES = ['item', 'pre_booking', 'pre_departure_check'] as const;
const VALID_BAGGAGE_TYPES = ['carry_on', 'checked', 'none'] as const;

type ValidCategory = (typeof VALID_CATEGORIES)[number];
type ValidPrepType = (typeof VALID_PREP_TYPES)[number];
type ValidBaggageType = (typeof VALID_BAGGAGE_TYPES)[number];

// ─── 테스트 케이스 ────────────────────────────────────────────────────────────

const TEST_CASES: Array<{ label: string; context: TripContext }> = [
  {
    label: '일본 도쿄 · 혼자 · 맛집',
    context: {
      destination: '일본 (도쿄)',
      durationDays: 5,
      season: '봄',
      travelMonth: 4,
      companions: [],
      purposes: ['맛집 탐방'],
    },
  },
  {
    label: '태국 방콕 · 친구 · 액티비티+나이트',
    context: {
      destination: '태국 (방콕)',
      durationDays: 7,
      season: '여름',
      travelMonth: 7,
      companions: ['친구'],
      purposes: ['액티비티', '클럽/나이트라이프'],
    },
  },
  {
    label: '중국 상하이 · 혼자 · 쇼핑',
    context: {
      destination: '중국 (상하이)',
      durationDays: 4,
      season: '가을',
      travelMonth: 10,
      companions: [],
      purposes: ['쇼핑'],
    },
  },
  {
    label: '일본 오사카 · 반려동물 · 힐링',
    context: {
      destination: '일본 (오사카)',
      durationDays: 6,
      season: '봄',
      travelMonth: 5,
      companions: ['반려동물'],
      purposes: ['힐링/휴양'],
    },
  },
  {
    label: '베트남 다낭 · 아이와 함께 · 해변+맛집',
    context: {
      destination: '베트남 (다낭)',
      durationDays: 5,
      season: '여름',
      travelMonth: 8,
      companions: ['아이와 함께'],
      purposes: ['해변/휴양', '맛집 탐방'],
    },
  },
];

// ─── 유효성 검증 ──────────────────────────────────────────────────────────────

interface RawItem {
  title?: unknown;
  category?: unknown;
  description?: unknown;
  prep_type?: unknown;
  baggage_type?: unknown;
}

interface ItemValidation {
  index: number;
  title: string;
  category: string;
  prepType: string;
  baggageType: string;
  description: string;
  issues: string[];
  valid: boolean;
}

function validateItem(raw: RawItem, index: number): ItemValidation {
  const issues: string[] = [];

  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const category = typeof raw.category === 'string' ? raw.category.trim() : '';
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  const prepType = typeof raw.prep_type === 'string' ? raw.prep_type.trim() : '';
  const baggageType = typeof raw.baggage_type === 'string' ? raw.baggage_type.trim() : '';

  if (!title) issues.push('title 비어있음');
  if (!VALID_CATEGORIES.includes(category as ValidCategory))
    issues.push(`category 무효: "${category || '(없음)'}"`);
  if (!VALID_PREP_TYPES.includes(prepType as ValidPrepType))
    issues.push(`prep_type 무효: "${prepType || '(없음)'}"`);
  if (!VALID_BAGGAGE_TYPES.includes(baggageType as ValidBaggageType))
    issues.push(`baggage_type 무효: "${baggageType || '(없음)'}"`);
  if (!description) issues.push('description 비어있음');

  return {
    index,
    title: title || '(없음)',
    category: category || '(없음)',
    prepType: prepType || '(없음)',
    baggageType: baggageType || '(없음)',
    description,
    issues,
    valid: issues.length === 0,
  };
}

// ─── 출력 헬퍼 ────────────────────────────────────────────────────────────────

const W = 74;
const BAR = '═'.repeat(W);
const DIV = '─'.repeat(W);

function header(text: string) {
  console.log(`\n${BAR}`);
  console.log(` ${text}`);
  console.log(BAR);
}

function sub(label: string) {
  console.log(`\n${DIV}`);
  console.log(` ${label}`);
  console.log(DIV);
}

function maskKey(key: string): string {
  if (!key) return '<empty>';
  if (key.length <= 10) return `${key.slice(0, 3)}***`;
  return `${key.slice(0, 7)}...${key.slice(-4)} (len=${key.length})`;
}

// ─── 케이스 실행 ──────────────────────────────────────────────────────────────

interface CaseResult {
  caseIndex: number;
  label: string;
  pass: boolean;
  itemCount: number;
  invalidCount: number;
  elapsed: number;
  error?: string;
}

async function runCase(
  caseIndex: number,
  label: string,
  context: TripContext,
  service: OpenaiService,
  client: OpenAI,
  model: string,
): Promise<CaseResult> {
  header(`케이스 ${caseIndex}: ${label}`);

  // ① 프롬프트 생성 (private 메서드 직접 접근)
  const svc = service as unknown as Record<string, (ctx: TripContext) => string>;
  const systemPrompt = svc['buildSystemPrompt'](context);
  const userPrompt = svc['buildUserPrompt'](context);

  sub('① System Prompt');
  console.log(systemPrompt);

  sub('② User Prompt');
  console.log(userPrompt);

  sub('③ OpenAI API 호출');
  console.log(` model: ${model}`);

  const startedAt = Date.now();

  try {
    const completion = await client.chat.completions.create({
      model,
      temperature: 0.5,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });

    const elapsed = Date.now() - startedAt;
    const rawContent = completion.choices[0]?.message?.content ?? '';
    const tokens = completion.usage?.total_tokens ?? 0;
    const promptTokens = completion.usage?.prompt_tokens ?? 0;
    const completionTokens = completion.usage?.completion_tokens ?? 0;

    console.log(` 실행 시간 : ${elapsed} ms`);
    console.log(` 토큰 사용 : ${tokens} (prompt ${promptTokens} + completion ${completionTokens})`);

    // ④ JSON 파싱 성공 여부
    sub('④ 응답 JSON 파싱');
    let parsed: { items: RawItem[] } = { items: [] };
    let parseOk = false;

    try {
      const maybeObj = JSON.parse(rawContent) as unknown;
      if (
        maybeObj !== null &&
        typeof maybeObj === 'object' &&
        'items' in maybeObj &&
        Array.isArray((maybeObj as { items: unknown }).items)
      ) {
        parsed = maybeObj as { items: RawItem[] };
        parseOk = true;
        console.log(` ✅ 파싱 성공 | 항목 수: ${parsed.items.length}개`);
      } else {
        console.log(` ⚠️  items 배열 없음`);
        console.log(` raw: ${rawContent.slice(0, 400)}`);
      }
    } catch {
      console.log(` ❌ JSON 파싱 실패`);
      console.log(` raw: ${rawContent.slice(0, 400)}`);
    }

    // ⑤ 항목별 유효성 검증 (raw LLM 응답 기준 — 정규화 전)
    sub('⑤ 항목 유효성 검증 (raw LLM 응답 기준)');

    const validations = parsed.items.map((item, idx) => validateItem(item, idx + 1));
    const invalidItems = validations.filter((v) => !v.valid);

    if (validations.length === 0) {
      console.log(' (항목 없음)');
    } else {
      validations.forEach((v) => {
        const icon = v.valid ? '✅' : '❌';
        const issueStr = v.issues.length ? `  ← ${v.issues.join(' | ')}` : '';
        console.log(`  ${String(v.index).padStart(2)}. ${icon} [${v.category}] ${v.title}${issueStr}`);
        console.log(`       prep=${v.prepType}  baggage=${v.baggageType}`);
        if (v.description) {
          const truncated =
            v.description.length > 90
              ? `${v.description.slice(0, 90)}...`
              : v.description;
          console.log(`       "${truncated}"`);
        }
      });
    }

    const pass = parseOk && invalidItems.length === 0 && parsed.items.length > 0;
    const resultIcon = pass ? '✅ PASS' : '❌ FAIL';
    console.log(
      `\n케이스 ${caseIndex} → ${resultIcon} | 항목 ${parsed.items.length}개 | 무효 ${invalidItems.length}개 | ${elapsed} ms`,
    );

    return { caseIndex, label, pass, itemCount: parsed.items.length, invalidCount: invalidItems.length, elapsed };
  } catch (e) {
    const elapsed = Date.now() - startedAt;
    const err = e as Error & { status?: number };
    console.log(`\n❌ API 호출 실패 (${elapsed} ms): ${err.message}`);
    if (err.status === 401) console.log(' → API Key 무효. .env 를 확인하세요.');
    else if (err.status === 429) console.log(' → Rate limit 또는 크레딧 부족.');
    else if (err.status === 404) console.log(` → 모델 "${model}" 접근 권한 없음.`);

    return { caseIndex, label, pass: false, itemCount: 0, invalidCount: 0, elapsed, error: err.message };
  }
}

// ─── 진입점 ───────────────────────────────────────────────────────────────────

async function main() {
  const apiKey = process.env.LLM_API_KEY ?? '';
  const model = process.env.LLM_MODEL ?? 'gpt-4o-mini';

  header('LLM Prompt Quality Test');
  console.log(` model   : ${model}`);
  console.log(` api key : ${maskKey(apiKey)}`);
  console.log(` cases   : ${TEST_CASES.length}`);

  if (!apiKey) {
    console.error('\n[FAIL] LLM_API_KEY 가 비어 있습니다. .env 를 확인하세요.');
    process.exit(1);
  }

  // NestJS ConfigService 를 DI 없이 단독 구성 (buildSystemPrompt/buildUserPrompt 접근용)
  const config = new ConfigService({ llm: { apiKey, model } });
  const service = new OpenaiService(config);

  // raw API 호출용 클라이언트 (정규화 전 응답 검증 목적)
  const client = new OpenAI({ apiKey, timeout: 30_000 });

  const results: CaseResult[] = [];

  for (let i = 0; i < TEST_CASES.length; i++) {
    const { label, context } = TEST_CASES[i];
    const result = await runCase(i + 1, label, context, service, client, model);
    results.push(result);
  }

  // ⑥ 전체 요약
  header('전체 요약');
  results.forEach((r) => {
    const icon = r.pass ? '✅' : '❌';
    const errStr = r.error ? `  [Error: ${r.error.slice(0, 55)}]` : '';
    console.log(
      ` 케이스 ${r.caseIndex}: ${icon} ${r.label.padEnd(28)} | ${String(r.itemCount).padStart(2)}개 | 무효 ${r.invalidCount}개 | ${r.elapsed} ms${errStr}`,
    );
  });

  console.log(DIV);

  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  const totalItems = results.reduce((s, r) => s + r.itemCount, 0);
  const totalInvalid = results.reduce((s, r) => s + r.invalidCount, 0);
  const totalElapsed = results.reduce((s, r) => s + r.elapsed, 0);

  console.log(
    ` 통과: ${passed}/${total} | 전체 항목: ${totalItems}개 | 무효: ${totalInvalid}개 | 총 소요: ${totalElapsed} ms`,
  );
  console.log(BAR);

  process.exit(passed === total ? 0 : 1);
}

main().catch((e) => {
  console.error('[FATAL]', (e as Error).message);
  process.exit(1);
});
