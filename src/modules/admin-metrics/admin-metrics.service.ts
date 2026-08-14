import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import type { CsvRow, CsvSection } from './csv.util';

/**
 * 스크럼 대시보드 지표 조회.
 * 노션 「Checkmate 스크럼 대시보드 쿼리」를 기간 파라미터와 함께 이식한 것.
 * 공통 규칙:
 *  - 팀원/지인(TEAM_MEMBER_EMAILS) 이벤트 제외
 *  - dev 빌드 이벤트(metadata._dev='true') 제외
 *  - "저장"은 guide_archives 테이블 기준 (docs/analytics-strategy.md)
 */
@Injectable()
export class AdminMetricsService {
  /** 보유 아티클 목적지 — 신규 아티클 추가 시 여기도 업데이트 */
  private static readonly ARTICLE_DESTINATIONS = ['일본', '베트남', '태국', '미국'];

  private readonly cache = new Map<string, { at: number; data: unknown }>();
  private static readonly CACHE_TTL_MS = 60_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** 팀원 이메일 목록 — 비어 있으면 매칭 불가능한 더미 값으로 대체해 SQL `in ()` 오류 방지 */
  private teamEmails(): Prisma.Sql {
    const emails = this.config.get<string[]>('admin.teamMemberEmails') ?? [];
    return Prisma.join(emails.length > 0 ? emails : ['__none__']);
  }

  /**
   * 자사 도메인 호스트 목록 — CORS_ORIGIN 에서 유도한다(하드코딩 방지).
   * 사이트 내부 이동으로 생긴 referrer 를 외부 유입으로 착각하지 않기 위한 것.
   */
  private selfHosts(): Prisma.Sql {
    const raw = this.config.get<string>('app.corsOrigin') ?? '';
    const hosts = raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && s !== '*')
      .map((origin) => {
        try {
          // host 쪽도 www. 를 떼고 비교하므로 여기서도 맞춰준다
          return new URL(origin).hostname.toLowerCase().replace(/^www\./, '');
        } catch {
          return '';
        }
      })
      .filter(Boolean);
    const unique = Array.from(new Set(hosts));
    return Prisma.join(unique.length > 0 ? unique : ['__none__']);
  }

  private async cached<T>(key: string, run: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < AdminMetricsService.CACHE_TTL_MS) return hit.data as T;
    const data = await run();
    this.cache.set(key, { at: Date.now(), data });
    return data;
  }

  /** 팀원·dev 제외가 적용된 user_events 필터 CTE 본문 (기간 필터 포함) */
  private realEventsSql(from: string, to: string): Prisma.Sql {
    return Prisma.sql`
      select e.*
      from user_events e
      left join users u on u.id = e.user_id
      where (u.email is null or lower(u.email) not in (${this.teamEmails()}))
        and coalesce(e.metadata->>'_dev', '') <> 'true'
        and e.occurred_at >= ${from}::date
        and e.occurred_at < ${to}::date + 1
    `;
  }

  /** 쿼리 1+2. 일별 핵심 퍼널 (방문→탐색→항목선택→저장 / 로그인→여행생성) */
  funnel(from: string, to: string) {
    return this.cached(`funnel:${from}:${to}`, () =>
      this.prisma.$queryRaw`
        with real_events as (${this.realEventsSql(from, to)}),
        session_stages as (
          select
            session_id,
            max(user_id)           as user_id,
            min(occurred_at)::date as day,
            bool_or(event_type = 'session_start')                                                   as visited,
            bool_or(event_type = 'search'       and metadata->>'_ev' = 'search_items_loaded')       as explored,
            bool_or(event_type = 'detail_check' and metadata->>'_ev' = 'search_item_toggle_select') as selected,
            bool_or(event_type = 'login'        and metadata->>'_ev' = 'login_completed')           as logged_in,
            -- travel_fixed 제외: trip_creation_completed 와 같은 세션에서 중복 발생
            bool_or(event_type = 'trip_created' and metadata->>'_ev' = 'trip_creation_completed')   as trip_created,
            -- 저장 시도(이벤트 기반·게스트 포함): 로그인 저장 확정 + 게스트 프리뷰 완료.
            -- 탐색/항목선택과 동일하게 session_id 기준이라 게스트도 잡혀 분모와 대칭이 됨.
            bool_or(metadata->>'_ev' in (
              'save_confirm_navigate_guide_archive',
              'save_confirm_navigate_guide_archive_merge',
              'guest_preview_complete_clicked'
            ))                                                                                       as saved_intent
          from real_events
          group by session_id
        ),
        session_with_save as (
          select
            ss.*,
            exists (
              select 1
              from trips t
              join checklists     cl on cl.trip_id      = t.id
              join guide_archives ga on ga.checklist_id = cl.id
              where t.user_id            = ss.user_id
                and ga.archived_at::date = ss.day
            ) as saved
          from session_stages ss
        )
        select
          day::text                                                                                    as day,
          (count(*) filter (where visited))::int                                                       as visited,
          (count(*) filter (where explored))::int                                                      as explored,
          (count(*) filter (where selected))::int                                                      as selected,
          (count(*) filter (where saved))::int                                                         as saved,
          (count(*) filter (where saved_intent))::int                                                  as saved_intent,
          (count(*) filter (where logged_in))::int                                                     as logged_in,
          (count(*) filter (where trip_created))::int                                                  as trip_created,
          round(100.0 * count(*) filter (where explored)     / nullif(count(*) filter (where visited),   0), 1)::float as visit_to_explore_pct,
          round(100.0 * count(*) filter (where saved)        / nullif(count(*) filter (where explored),  0), 1)::float as explore_to_save_pct,
          -- 탐색→저장시도: 게스트 포함·대칭(이벤트 기준) — 로그인 후순위 효과가 그대로 잡히는 "진짜" 전환율
          round(100.0 * count(*) filter (where saved_intent) / nullif(count(*) filter (where explored),     0), 1)::float as explore_to_save_intent_pct,
          -- 저장시도→실제보관: 로그인 관문에서 새는 비율(영속 전환) — 로그인 미루기의 비용
          round(100.0 * count(*) filter (where saved)        / nullif(count(*) filter (where saved_intent), 0), 1)::float as intent_to_persist_pct,
          round(100.0 * count(*) filter (where trip_created) / nullif(count(*) filter (where logged_in), 0), 1)::float as login_to_trip_pct
        from session_with_save
        group by day
        order by day
      `,
    );
  }

  /** 쿼리 3. 신규 로그인 + 누적 로그인 유저 (누적은 전체 이력 기준, 표시만 기간 필터) */
  logins(from: string, to: string) {
    return this.cached(`logins:${from}:${to}`, () =>
      this.prisma.$queryRaw`
        with real_events as (
          select e.*
          from user_events e
          left join users u on u.id = e.user_id
          where (u.email is null or lower(u.email) not in (${this.teamEmails()}))
            and coalesce(e.metadata->>'_dev', '') <> 'true'
        ),
        first_login as (
          select user_id, min(occurred_at)::date as login_day
          from real_events
          where event_type = 'login'
            and metadata->>'_ev' = 'login_completed'
            and user_id is not null
          group by user_id
        ),
        daily as (
          select login_day as day, count(*)::int as new_logins
          from first_login
          group by login_day
        )
        select
          day::text                                       as day,
          new_logins,
          (sum(new_logins) over (order by day))::int      as cumulative
        from daily
        where day between ${from}::date and ${to}::date
        order by day
      `,
    );
  }

  /** 일별 채널 표에서 개별 노출할 상위 채널 수 — 나머지는 '기타' 로 묶어 행 폭증을 막는다 */
  private static readonly CHANNEL_DAILY_TOP_N = 6;
  /** 채널 하나당 드릴다운으로 보여줄 원본 referrer 수 */
  private static readonly CHANNEL_REFERRERS_PER_CHANNEL = 5;

  /**
   * 채널 집계 공통 CTE.
   * session_start 의 utm_source(토큰) → referrer(URL) → direct/unknown 순으로 출처를 정하고,
   * URL 이면 host 를 뽑아 매체 단위 라벨로 정규화한다.
   * 정규화 전에는 같은 네이버 카페 글이 쿼리스트링 차이만으로 각각 다른 행이 되어
   * (날짜 × 원본URL) 카디널리티가 수백 행까지 부풀었다.
   */
  private channelsCte(from: string, to: string): Prisma.Sql {
    return Prisma.sql`
      real_events as (${this.realEventsSql(from, to)}),
      session_source as (
        select
          session_id,
          min(occurred_at)::date as day,
          coalesce(
            (array_agg(metadata->>'utm_source') filter (where metadata->>'utm_source' is not null))[1],
            (array_agg(metadata->>'referrer')   filter (where metadata->>'referrer'   is not null))[1],
            'direct/unknown'
          ) as source
        from real_events
        where event_type = 'session_start'
        group by session_id
      ),
      hosted as (
        select
          session_id,
          day,
          source,
          -- URL 이면 스킴 뒤 host, utm_source 처럼 토큰이면 값 자체.
          -- www. 는 떼어낸다 (www.example.com 과 example.com 이 다른 채널로 갈리는 것 방지)
          regexp_replace(
            coalesce(
              nullif(lower(substring(source from '^[a-zA-Z][a-zA-Z0-9+.-]*://([^/?#]+)')), ''),
              lower(source)
            ),
            '^www\\.', ''
          ) as host
        from session_source
      ),
      labeled as (
        select
          session_id,
          day,
          source,
          case
            when host = 'direct/unknown'                                            then 'direct/unknown'
            when host in (${this.selfHosts()})                                       then '내부이동(자사)'
            when host like '%cafe.naver.com'                                         then '네이버 카페'
            when host like '%blog.naver.com'                                         then '네이버 블로그'
            when host like '%search.naver.com'                                       then '네이버 검색'
            when host like '%naver.com' or host = 'naver'                            then '네이버 기타'
            when host like '%kakao.com'  or host like '%kakaocdn.net'
              or host like '%daum.net'   or host in ('kakao', 'kakaotalk')           then '카카오'
            -- 'ig' 는 우리가 광고에 심는 utm_source 토큰 (utm_medium=paid|social)
            when host like '%instagram.com' or host in ('instagram', 'insta', 'ig')  then '인스타그램'
            when host like '%google.%'      or host = 'google'                       then '구글'
            when host like '%youtube.%'     or host like '%youtu.be'                 then '유튜브'
            when host like '%facebook.%'    or host like '%fb.%'                     then '페이스북'
            when host like '%threads.%'                                              then '스레드'
            when host like '%tiktok.%'                                               then '틱톡'
            when host like '%x.com' or host like '%twitter.com'                      then 'X(트위터)'
            else host
          end as channel
        from hosted
      )
    `;
  }

  /**
   * 쿼리 4. 유입 채널별 세션.
   * summary(기간 합계·기본 뷰) / daily(일별 전개·상위 N + 기타) / referrers(채널별 원본 URL 드릴다운).
   */
  channels(from: string, to: string) {
    return this.cached(`channels:${from}:${to}`, async () => {
      // 3개 표를 한 번의 왕복으로 받는다. 쿼리를 나누면 무거운 labeled CTE(user_events 전체 스캔)를
      // 세 번 다시 계산하게 되어 응답이 1초를 넘었다. 여러 번 참조되는 CTE 는 PG 가 한 번만 실체화한다.
      const rows = (await this.prisma.$queryRaw`
        with ${this.channelsCte(from, to)},
        summary as (
          select
            channel,
            count(*)::int                                             as sessions,
            round(100.0 * count(*) / sum(count(*)) over (), 1)::float  as share_pct
          from labeled
          group by channel
          order by count(*) desc, channel
          limit 20
        ),
        top_channels as (
          select channel
          from labeled
          group by channel
          order by count(*) desc, channel
          limit ${AdminMetricsService.CHANNEL_DAILY_TOP_N}
        ),
        daily as (
          select
            day::text as day,
            case when channel in (select channel from top_channels) then channel else '기타' end as channel,
            count(*)::int as sessions
          from labeled
          group by 1, 2
        ),
        ranked as (
          select
            channel,
            source,
            count(*)::int                                                        as sessions,
            row_number() over (partition by channel order by count(*) desc, source) as rn
          from labeled
          where source <> 'direct/unknown'
          group by channel, source
        ),
        referrers as (
          select channel, source, sessions
          from ranked
          where rn <= ${AdminMetricsService.CHANNEL_REFERRERS_PER_CHANNEL}
        )
        select
          (select coalesce(json_agg(t order by t.sessions desc, t.channel), '[]'::json)
             from summary t)   as summary,
          (select coalesce(json_agg(t order by t.day desc, t.sessions desc, t.channel), '[]'::json)
             from daily t)     as daily,
          (select coalesce(json_agg(t order by t.channel, t.sessions desc), '[]'::json)
             from referrers t) as referrers
      `) as Array<{ summary: unknown[]; daily: unknown[]; referrers: unknown[] }>;

      const row = rows[0];
      return {
        summary: row?.summary ?? [],
        daily: row?.daily ?? [],
        referrers: row?.referrers ?? [],
      };
    });
  }

  /** 쿼리 7. 목적지 탐색수 vs 아티클 보유 (전체 기간) */
  contentGap() {
    return this.cached('contentGap', () =>
      this.prisma.$queryRaw`
        with dest_demand as (
          select co.name_ko as dest, count(distinct t.id)::int as trips
          from trips t
          join countries co on co.id = t.country_id
          join users u      on u.id  = t.user_id
          where lower(u.email) not in (${this.teamEmails()})
            and t.deleted_at is null
          group by co.name_ko
        ),
        articles as (
          select unnest(array[${Prisma.join(AdminMetricsService.ARTICLE_DESTINATIONS)}]) as dest
        )
        select d.dest, d.trips, (a.dest is not null) as has_article
        from dest_demand d
        left join articles a on a.dest = d.dest
        order by d.trips desc
      `,
    );
  }

  /** 쿼리 8. 가입 코호트별 D1/D7 리텐션 (가입일 기준 기간 필터) */
  retention(from: string, to: string) {
    return this.cached(`retention:${from}:${to}`, () =>
      this.prisma.$queryRaw`
        with cohort as (
          select id, created_at::date as cohort_day
          from users
          where lower(email) not in (${this.teamEmails()})
            and deleted_at is null
            and created_at >= ${from}::date
            and created_at < ${to}::date + 1
        ),
        activity as (
          select distinct e.user_id as id, e.occurred_at::date as active_day
          from user_events e
          join users u on u.id = e.user_id
          where lower(u.email) not in (${this.teamEmails()})
            and e.user_id is not null
        )
        select
          c.cohort_day::text                                                              as cohort_day,
          count(distinct c.id)::int                                                       as signups,
          (count(distinct c.id) filter (where a.active_day = c.cohort_day + 1))::int      as d1_returned,
          (count(distinct c.id) filter (where a.active_day = c.cohort_day + 7))::int      as d7_returned,
          round(100.0 * count(distinct c.id) filter (where a.active_day = c.cohort_day + 1)
                / nullif(count(distinct c.id), 0), 1)::float                              as d1_pct,
          round(100.0 * count(distinct c.id) filter (where a.active_day = c.cohort_day + 7)
                / nullif(count(distinct c.id), 0), 1)::float                              as d7_pct
        from cohort c
        left join activity a on a.id = c.id
        group by c.cohort_day
        order by c.cohort_day
      `,
    );
  }

  /** 쿼리 9. 저장 유저 vs 비저장 유저 재방문율 (전체 기간) */
  saveRetention() {
    return this.cached('saveRetention', () =>
      this.prisma.$queryRaw`
        with per_user as (
          select
            u.id,
            exists (
              select 1
              from guide_archives ga
              join checklists cl on cl.id = ga.checklist_id
              join trips t       on t.id  = cl.trip_id
              where t.user_id = u.id
            ) as ever_saved,
            count(distinct e.occurred_at::date)::int as visit_days
          from users u
          left join user_events e on e.user_id = u.id
          where lower(u.email) not in (${this.teamEmails()})
            and u.deleted_at is null
          group by u.id
        )
        select
          ever_saved,
          count(*)::int                                                            as users,
          round(avg(visit_days), 2)::float                                         as avg_visit_days,
          (count(*) filter (where visit_days > 1))::int                            as returned_users,
          round(100.0 * count(*) filter (where visit_days > 1) / count(*), 1)::float as return_pct
        from per_user
        group by ever_saved
        order by ever_saved
      `,
    );
  }

  /** 쿼리 10. 게스트 프리뷰 퍼널 (비로그인 저장 플로우 — docs/analytics-strategy.md) */
  guestPreview(from: string, to: string) {
    return this.cached(`guestPreview:${from}:${to}`, () =>
      this.prisma.$queryRaw`
        with real_events as (${this.realEventsSql(from, to)}),
        session_stages as (
          select
            session_id,
            min(occurred_at)::date as day,
            bool_or(metadata->>'_ev' = 'guest_preview_opened')           as preview_opened,
            bool_or(metadata->>'_ev' = 'guest_preview_complete_clicked') as complete_clicked,
            bool_or(metadata->>'_ev' = 'guest_preview_login_redirect')   as login_redirected,
            bool_or(metadata->>'_ev' = 'guest_preview_leave_anyway')     as left_anyway,
            bool_or(event_type = 'save'
                and metadata->>'mode' in ('guest_upgrade', 'guest_curation_upgrade')) as guest_saved
          from real_events
          group by session_id
        )
        select
          day::text                                            as day,
          (count(*) filter (where preview_opened))::int        as preview_opened,
          (count(*) filter (where complete_clicked))::int      as complete_clicked,
          (count(*) filter (where login_redirected))::int      as login_redirected,
          (count(*) filter (where guest_saved))::int           as guest_saved,
          (count(*) filter (where left_anyway))::int           as left_anyway,
          round(100.0 * count(*) filter (where guest_saved)
                / nullif(count(*) filter (where preview_opened), 0), 1)::float as preview_to_save_pct
        from session_stages
        where preview_opened
        group by day
        order by day
      `,
    );
  }

  /** 쿼리 11. 여행 스타일 테스트 퍼널 (진입→시작→완료→결과→공유/체크리스트) */
  travelTest(from: string, to: string) {
    return this.cached(`travelTest:${from}:${to}`, () =>
      this.prisma.$queryRaw`
        with real_events as (${this.realEventsSql(from, to)}),
        session_stages as (
          select
            session_id,
            min(occurred_at)::date as day,
            bool_or(metadata->>'_ev' = 'travel_test_landing_viewed')    as landing_viewed,
            bool_or(metadata->>'_ev' = 'travel_test_started')           as started,
            bool_or(metadata->>'_ev' = 'travel_test_completed')         as completed,
            bool_or(metadata->>'_ev' = 'travel_test_result_viewed'
                and metadata->>'shared' = 'true')                       as shared_inflow,
            bool_or(metadata->>'_ev' in ('travel_test_share_link', 'travel_test_share_image')) as shared,
            bool_or(metadata->>'_ev' = 'travel_test_checklist_create')  as checklist_created
          from real_events
          where metadata->>'_ev' like 'travel_test%'
          group by session_id
        )
        select
          day::text                                          as day,
          (count(*) filter (where landing_viewed))::int      as landing_viewed,
          (count(*) filter (where started))::int             as started,
          (count(*) filter (where completed))::int           as completed,
          (count(*) filter (where shared))::int              as shared,
          (count(*) filter (where checklist_created))::int   as checklist_created,
          (count(*) filter (where shared_inflow))::int       as shared_inflow,
          round(100.0 * count(*) filter (where completed)
                / nullif(count(*) filter (where started), 0), 1)::float as start_to_complete_pct,
          round(100.0 * count(*) filter (where checklist_created)
                / nullif(count(*) filter (where completed), 0), 1)::float as complete_to_checklist_pct
        from session_stages
        group by day
        order by day
      `,
    );
  }

  /** 쿼리 13. 친구·협업 퍼널 — 일별 이벤트 수 (초대→수락) */
  collab(from: string, to: string) {
    return this.cached(`collab:${from}:${to}`, () =>
      this.prisma.$queryRaw`
        with real_events as (${this.realEventsSql(from, to)})
        select
          occurred_at::date::text as day,
          (count(*) filter (where metadata->>'_ev' = 'friend_invite_created'))::int  as friend_invites,
          (count(*) filter (where metadata->>'_ev' = 'friend_invite_accepted'))::int as friends_made,
          (count(*) filter (where metadata->>'_ev' in ('trip_invite_sent', 'trip_invite_link_created')))::int as trip_invites,
          (count(*) filter (where metadata->>'_ev' = 'trip_invite_accepted'))::int   as trip_joins,
          (count(*) filter (where metadata->>'_ev' = 'trip_invite_declined'))::int   as trip_declines
        from real_events
        where metadata->>'_ev' in (
          'friend_invite_created', 'friend_invite_accepted',
          'trip_invite_sent', 'trip_invite_link_created',
          'trip_invite_accepted', 'trip_invite_declined'
        )
        group by 1
        order by 1
      `,
    );
  }

  /**
   * 쿼리 14. 광고 타겟 항목 분석.
   * 탐색 단계 "선택 클릭"(능동적 담기 = 구매의도 신호)을 1차 기준으로,
   * 보관함 "저장 유저수"(의도 지속)를 보조 지표로 함께 노출한다.
   * 저장 빈도는 AI 기본 세트를 통째로 저장하는 특성상 변별력이 낮아 선택 클릭을 주 정렬로 둔다.
   * ad_category: 제휴/광고가 실제로 붙는 항목만 분류(eSIM·환전·항공·숙소·보험 등) — null이면 광고가치 낮음.
   */
  adTargeting(from: string, to: string) {
    return this.cached(`adTargeting:${from}:${to}`, () =>
      this.prisma.$queryRaw`
        with real_events as (${this.realEventsSql(from, to)}),
        clk as (
          -- 탐색에서 담기 토글 ON → item_id로 항목명(title) 복원
          select re.session_id, ci.title
          from real_events re
          join checklist_items ci on ci.id = re.item_id
          where re.event_type = 'detail_check'
            and re.metadata->>'_ev' = 'search_item_toggle_select'
            and re.metadata->>'selected_after' = 'true'
        ),
        clk_tot as (select count(*) as n from clk),
        sel as (
          select title,
            count(*)::int                  as select_clicks,
            count(distinct session_id)::int as select_sessions
          from clk
          group by title
        ),
        sav as (
          -- 보관함 저장(영속): is_selected=true 행, 기간은 selected_at 기준
          select ci.title, count(distinct t.user_id)::int as save_users
          from checklist_items ci
          join checklists cl on cl.id = ci.checklist_id
          join trips t       on t.id  = cl.trip_id
          join users u       on u.id  = t.user_id
          where ci.is_selected = true
            and ci.deleted_at is null
            and t.deleted_at is null
            and u.deleted_at is null
            and lower(u.email) not in (${this.teamEmails()})
            and ci.selected_at >= ${from}::date
            and ci.selected_at < ${to}::date + 1
          group by ci.title
        )
        select
          sel.title,
          sel.select_clicks,
          sel.select_sessions,
          round(100.0 * sel.select_clicks / nullif((select n from clk_tot), 0), 1)::float as select_share_pct,
          coalesce(sav.save_users, 0)::int as save_users,
          case
            when sel.title ilike any (array['%이심%', '%유심%', '%로밍%', '%와이파이%']) then 'eSIM/로밍'
            when sel.title ilike any (array['%환전%', '%현금%', '%카드%'])                then '환전/트래블카드'
            when sel.title ilike '%항공권%'                                              then '항공권 OTA'
            when sel.title ilike '%숙소%'                                                then '숙소 예약'
            when sel.title ilike '%보험%'                                                then '여행자보험'
            when sel.title ilike '%여권%'                                                then '여권/비자 서비스'
            else null
          end as ad_category
        from sel
        left join sav on sav.title = sel.title
        order by sel.select_clicks desc, sel.select_sessions desc
        limit 15
      `,
    );
  }

  /** 쿼리 12. 여행 스타일 테스트 결과 유형 분포 (travel_test_completed의 result 메타 기준) */
  travelTestTypes(from: string, to: string) {
    return this.cached(`travelTestTypes:${from}:${to}`, () =>
      this.prisma.$queryRaw`
        with real_events as (${this.realEventsSql(from, to)})
        select
          metadata->>'result'                                       as result_type,
          count(*)::int                                             as cnt,
          round(100.0 * count(*) / sum(count(*)) over (), 1)::float as pct
        from real_events
        where metadata->>'_ev' = 'travel_test_completed'
          and metadata->>'result' is not null
        group by 1
        order by cnt desc
      `,
    );
  }

  /**
   * 쿼리 15. 제휴 클릭 지표 (affiliate_click 이벤트).
   * 일별 추이 / provider별 / 항목별 TOP / 퍼널 교차(탐색·저장 세션 중 클릭 비율).
   * 구매 전환·수익은 우리 DB 밖(제휴사 리포트)이라 클릭까지만.
   */
  affiliateClicks(from: string, to: string) {
    return this.cached(`affiliateClicks:${from}:${to}`, async () => {
      const daily = (await this.prisma.$queryRaw`
        with real_events as (${this.realEventsSql(from, to)})
        select
          occurred_at::date::text as day,
          (count(*) filter (where metadata->>'provider' = 'coupang'))::int as coupang,
          (count(*) filter (where metadata->>'provider' = 'mrt'))::int     as mrt,
          count(*)::int as total
        from real_events
        where metadata->>'_ev' = 'affiliate_click'
        group by day
        order by day
      `) as unknown[];

      const byProvider = (await this.prisma.$queryRaw`
        with real_events as (${this.realEventsSql(from, to)})
        select
          coalesce(metadata->>'provider', '(unknown)') as provider,
          count(*)::int                                as clicks,
          count(distinct session_id)::int             as sessions
        from real_events
        where metadata->>'_ev' = 'affiliate_click'
        group by 1
        order by clicks desc
      `) as unknown[];

      const topItems = (await this.prisma.$queryRaw`
        with real_events as (${this.realEventsSql(from, to)})
        select
          metadata->>'item'                     as item,
          coalesce(metadata->>'provider', '')   as provider,
          count(*)::int                         as clicks,
          count(distinct session_id)::int       as sessions
        from real_events
        where metadata->>'_ev' = 'affiliate_click' and metadata->>'item' is not null
        group by 1, 2
        order by clicks desc
        limit 15
      `) as unknown[];

      const summaryRows = (await this.prisma.$queryRaw`
        with real_events as (${this.realEventsSql(from, to)}),
        session_stages as (
          select
            session_id,
            max(user_id)           as user_id,
            min(occurred_at)::date as day,
            bool_or(event_type = 'search' and metadata->>'_ev' = 'search_items_loaded') as explored,
            bool_or(metadata->>'_ev' = 'affiliate_click')                                as clicked
          from real_events
          group by session_id
        ),
        sws as (
          select ss.*, exists (
            select 1
            from trips t
            join checklists     cl on cl.trip_id      = t.id
            join guide_archives ga on ga.checklist_id = cl.id
            where t.user_id = ss.user_id and ga.archived_at::date = ss.day
          ) as saved
          from session_stages ss
        )
        select
          (count(*) filter (where clicked))::int   as click_sessions,
          (count(*) filter (where explored))::int  as explore_sessions,
          (count(*) filter (where saved))::int     as saved_sessions,
          round(100.0 * count(*) filter (where explored and clicked) / nullif(count(*) filter (where explored), 0), 1)::float as explore_to_click_pct,
          round(100.0 * count(*) filter (where saved and clicked)    / nullif(count(*) filter (where saved), 0), 1)::float    as save_to_click_pct
        from sws
      `) as Array<Record<string, unknown>>;

      const totalRows = (await this.prisma.$queryRaw`
        with real_events as (${this.realEventsSql(from, to)})
        select count(*)::int as total_clicks
        from real_events
        where metadata->>'_ev' = 'affiliate_click'
      `) as Array<Record<string, unknown>>;

      return {
        daily,
        byProvider,
        topItems,
        summary: { ...(totalRows[0] ?? {}), ...(summaryRows[0] ?? {}) },
      };
    });
  }

  /**
   * 내보내기 대상 데이터셋 목록 — 대시보드에 그려지는 것과 동일한 집계.
   * 새 지표를 추가하면 여기에도 한 줄 추가해야 파일에 포함된다.
   */
  static readonly EXPORT_DATASETS: ReadonlyArray<{ key: string; label: string }> = [
    { key: 'funnel', label: '일별 핵심 퍼널 (방문→탐색→항목선택→저장시도→실제저장 / 로그인→여행생성)' },
    { key: 'logins', label: '일별 신규 로그인 + 누적 로그인 유저' },
    { key: 'channels', label: '유입 채널별 세션 합계 (매체 단위 정규화 · 기간 전체)' },
    { key: 'channels_daily', label: `일별 유입 채널별 세션 (상위 ${AdminMetricsService.CHANNEL_DAILY_TOP_N}개 채널 + 기타)` },
    { key: 'channels_referrers', label: '채널별 원본 referrer/utm_source TOP5 (정규화 이전 값)' },
    { key: 'content_gap', label: '목적지별 여행 생성수 vs 큐레이션 아티클 보유 여부 (전체 기간 · 기간필터 무시)' },
    { key: 'retention', label: '가입 코호트별 D1/D7 리텐션 (가입일 기준 기간필터)' },
    { key: 'save_retention', label: '저장 경험 유저 vs 미저장 유저 재방문율 (전체 기간 · 기간필터 무시)' },
    { key: 'guest_preview', label: '게스트 프리뷰 퍼널 (비로그인 저장 플로우)' },
    { key: 'travel_test', label: '여행 스타일 테스트 퍼널 (진입→시작→완료→공유/체크리스트)' },
    { key: 'travel_test_types', label: '여행 스타일 테스트 결과 유형 분포' },
    { key: 'collab', label: '친구·협업 퍼널 (초대→수락 일별 이벤트 수)' },
    { key: 'ad_targeting', label: '광고 타겟 항목 TOP15 (탐색 담기 클릭 점유율 + 저장 유저수)' },
    { key: 'affiliate_clicks_daily', label: '제휴 클릭 일별 추이 (provider별)' },
    { key: 'affiliate_clicks_by_provider', label: '제휴 클릭 provider별 합계' },
    { key: 'affiliate_clicks_top_items', label: '제휴 클릭 항목별 TOP15' },
    { key: 'affiliate_clicks_summary', label: '제휴 클릭 요약 (탐색·저장 세션 대비 클릭 비율)' },
  ];

  /**
   * 대시보드 전체(또는 지정 1개) 데이터셋을 행 배열 형태로 모아 반환.
   * 각 지표 메서드를 그대로 재사용하므로 60초 캐시와 집계 규칙이 화면과 동일하다.
   */
  async exportDatasets(from: string, to: string, only?: string): Promise<CsvSection[]> {
    const wanted = !only || only === 'all' ? null : only;
    const want = (key: string) => wanted === null || wanted === key;
    const rowsOf = async (run: () => Promise<unknown>) => (await run()) as CsvRow[];

    const collected = new Map<string, CsvRow[]>();

    if (want('funnel')) collected.set('funnel', await rowsOf(() => this.funnel(from, to)));
    if (want('logins')) collected.set('logins', await rowsOf(() => this.logins(from, to)));
    if (want('content_gap')) collected.set('content_gap', await rowsOf(() => this.contentGap()));
    if (want('retention')) collected.set('retention', await rowsOf(() => this.retention(from, to)));
    if (want('save_retention')) collected.set('save_retention', await rowsOf(() => this.saveRetention()));
    if (want('guest_preview')) collected.set('guest_preview', await rowsOf(() => this.guestPreview(from, to)));
    if (want('travel_test')) collected.set('travel_test', await rowsOf(() => this.travelTest(from, to)));
    if (want('travel_test_types'))
      collected.set('travel_test_types', await rowsOf(() => this.travelTestTypes(from, to)));
    if (want('collab')) collected.set('collab', await rowsOf(() => this.collab(from, to)));
    if (want('ad_targeting')) collected.set('ad_targeting', await rowsOf(() => this.adTargeting(from, to)));

    // 채널은 한 번의 호출이 3개 표를 함께 반환한다 (캐시 공유).
    const channelKeys = ['channels', 'channels_daily', 'channels_referrers'];
    if (channelKeys.some(want)) {
      const ch = await this.channels(from, to);
      if (want('channels')) collected.set('channels', ch.summary as CsvRow[]);
      if (want('channels_daily')) collected.set('channels_daily', ch.daily as CsvRow[]);
      if (want('channels_referrers')) collected.set('channels_referrers', ch.referrers as CsvRow[]);
    }

    // 제휴 클릭은 한 번의 호출이 4개 표를 함께 반환한다 (캐시 공유).
    const affKeys = [
      'affiliate_clicks_daily',
      'affiliate_clicks_by_provider',
      'affiliate_clicks_top_items',
      'affiliate_clicks_summary',
    ];
    if (affKeys.some(want)) {
      const aff = await this.affiliateClicks(from, to);
      if (want('affiliate_clicks_daily')) collected.set('affiliate_clicks_daily', aff.daily as CsvRow[]);
      if (want('affiliate_clicks_by_provider'))
        collected.set('affiliate_clicks_by_provider', aff.byProvider as CsvRow[]);
      if (want('affiliate_clicks_top_items'))
        collected.set('affiliate_clicks_top_items', aff.topItems as CsvRow[]);
      if (want('affiliate_clicks_summary')) collected.set('affiliate_clicks_summary', [aff.summary as CsvRow]);
    }

    // EXPORT_DATASETS 순서를 유지해 파일 구성이 매번 동일하게 나오도록 한다.
    return AdminMetricsService.EXPORT_DATASETS.filter((d) => collected.has(d.key)).map((d) => ({
      key: d.key,
      label: d.label,
      rows: collected.get(d.key) ?? [],
    }));
  }
}
