-- ============================================================
-- Supabase Security Lint 대응: public 테이블 RLS 활성화
-- ============================================================
-- 배경:
--   모든 데이터 접근은 NestJS + Prisma 백엔드(postgres 롤, BYPASSRLS)와
--   service_role 키로만 이루어진다. 프론트엔드 Supabase 클라이언트(anon 키)는
--   인증(auth.*) / 실시간 채널(Broadcast) 전용이며, 어떤 public 테이블도
--   PostgREST(.from())로 직접 조회하지 않는다(postgres_changes 구독 없음).
--
--   따라서 RLS를 켜고 정책(policy)을 두지 않으면:
--     - anon / authenticated → 전면 차단 (경고 rls_disabled_in_public 해소)
--     - postgres / service_role → RLS 우회 (백엔드 정상 동작)
--     - Broadcast 실시간 → 테이블 RLS와 무관하므로 영향 없음
--
-- 실행 위치: Supabase 대시보드 > SQL Editor (또는 service_role 연결)
-- 안전성: additive. 정책을 추가하지 않으므로 PostgREST 외부 접근만 막힌다.
--
-- ⚠️ 개별 테이블 나열 대신 "public 스키마의 RLS 미설정 테이블 전체"를 동적으로
--    처리한다. 새 테이블이 추가돼도 이 스크립트를 다시 돌리면 자동 커버되어,
--    테이블별로 린트 경고가 새는 일이 없다. (기존 버전은 7개만 나열해
--    affiliate_links 등 이후 추가 테이블이 누락됐었다.)
-- ============================================================

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND rowsecurity = false
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', r.tablename);
    RAISE NOTICE 'RLS enabled: public.%', r.tablename;
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- 검증: public 의 모든 테이블 rowsecurity 가 true 여야 한다
-- (rowsecurity = false 인 행이 하나도 없어야 정상)
-- ------------------------------------------------------------
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY rowsecurity, tablename;
