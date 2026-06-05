import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';

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
            bool_or(event_type = 'trip_created' and metadata->>'_ev' = 'trip_creation_completed')   as trip_created
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
          (count(*) filter (where logged_in))::int                                                     as logged_in,
          (count(*) filter (where trip_created))::int                                                  as trip_created,
          round(100.0 * count(*) filter (where explored)     / nullif(count(*) filter (where visited),   0), 1)::float as visit_to_explore_pct,
          round(100.0 * count(*) filter (where saved)        / nullif(count(*) filter (where explored),  0), 1)::float as explore_to_save_pct,
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

  /** 쿼리 4. 유입 채널별 세션 — session_start 에 utm_source/referrer 계측 필요 */
  channels(from: string, to: string) {
    return this.cached(`channels:${from}:${to}`, () =>
      this.prisma.$queryRaw`
        with real_events as (${this.realEventsSql(from, to)}),
        session_source as (
          select
            session_id,
            min(occurred_at)::date as day,
            coalesce(
              (array_agg(metadata->>'utm_source') filter (where metadata->>'utm_source' is not null))[1],
              (array_agg(metadata->>'referrer')   filter (where metadata->>'referrer'   is not null))[1],
              'direct/unknown'
            ) as channel
          from real_events
          where event_type = 'session_start'
          group by session_id
        )
        select day::text as day, channel, count(*)::int as sessions
        from session_source
        group by day, channel
        order by day desc, sessions desc
      `,
    );
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
}
