import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Logger,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  AuthUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { ChecklistsService } from './checklists.service';
import { ChecklistItemService } from './checklist-item.service';
import { TripAccessService } from '../trips/trip-access.service';
import { GenerateFromContextDto } from './dto/generate-from-context.dto';
import {
  CheckItemDto,
  EditItemDto,
  UpsertItemsDto,
} from './dto/upsert-items.dto';
import { ReclassifyGuideArchiveDto } from './dto/reclassify-guide-archive.dto';

@Controller('checklists')
export class ChecklistsController {
  private readonly logger = new Logger(ChecklistsController.name);

  constructor(
    private readonly checklists: ChecklistsService,
    private readonly checklistItems: ChecklistItemService,
    private readonly tripAccess: TripAccessService,
  ) {}

  /**
   * 전세계 공통 기본 템플릿 목록 조회 (countryId=null).
   *
   *   GET /api/checklists/templates/global
   *   응답: [{ categoryCode, categoryLabel, items: [{ id, title, prepType, baggageType, isEssential }] }]
   *
   * 비로그인 허용(@Public) — 큐레이션 페이지 저장하기 흐름에서 사용.
   */
  @Public()
  @Get('templates/global')
  getGlobalTemplates() {
    return this.checklists.getGlobalTemplates();
  }

  /**
   * "내 체크리스트" 조회 — isSelected=true 인 아이템만 포함된 GeneratedChecklist 반환.
   * 후보 풀 전체(미선택 포함)가 필요하면 GET /api/checklists/by-trip/:tripId/candidates 를 사용.
   *
   * 응답 형태: GeneratedChecklist
   *   {
   *     tripId: string,
   *     context: TripContext,
   *     summary: { total, fromTemplate, fromLlm, ... },
   *     sections: [{ categoryCode, categoryLabel, items: GeneratedChecklistItem[] }],
   *     items: GeneratedChecklistItem[]   // isSelected 는 항상 true
   *   }
   *
   * 체크리스트가 아직 생성되지 않은 경우 404 반환.
   * 먼저 POST /api/checklists/generate/:tripId 를 호출해야 한다.
   */
  @Get('by-trip/:tripId')
  async byTrip(
    @CurrentUser() user: AuthUser | undefined,
    @Param('tripId', ParseIntPipe) tripId: number,
  ) {
    const userId = this.requireUserId(user);
    await this.tripAccess.assertTripAccess(BigInt(tripId), userId);
    return this.checklists.getByTrip(BigInt(tripId), userId);
  }

  /**
   * 후보 풀 조회 — 영속화된 ChecklistItem 전부를 `GeneratedChecklist` 형태로 돌려준다.
   * 아직 생성된 적이 없으면 404 — 먼저 POST /generate/:tripId 를 호출해야 한다.
   *
   *   GET /api/checklists/by-trip/:tripId/candidates
   */
  @Get('by-trip/:tripId/candidates')
  async listCandidates(
    @CurrentUser() user: AuthUser | undefined,
    @Param('tripId', ParseIntPipe) tripId: number,
  ) {
    const userId = this.requireUserId(user);
    await this.tripAccess.assertTripAccess(BigInt(tripId), userId);
    return this.checklists.listCandidatesForTrip(BigInt(tripId));
  }

  /**
   * 맞춤형 체크리스트 생성 (멱등).
   *
   *   POST /api/checklists/generate/:tripId
   *
   * - 이미 trip 에 영속화된 Checklist+Items 가 있으면 OpenAI 호출 없이 DB 항목을 돌려준다.
   * - 없으면 DB 기본 템플릿 + OpenAI 추천을 통합해 후보 풀로 저장한 뒤 돌려준다.
   *   같은 trip 으로 N 회 호출해도 OpenAI 는 최대 1회만 호출된다.
   */
  @Post('generate/:tripId')
  @HttpCode(202)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  generate(@Param('tripId', ParseIntPipe) tripId: number) {
    void this.checklists.generateForTripBackground(BigInt(tripId));
    return { status: 'generating' };
  }

  /**
   * 체크리스트 생성 완료 여부 polling 용.
   *
   *   GET /api/checklists/generate/:tripId/status
   *   응답: { status: 'completed' | 'generating' }
   */
  @Get('generate/:tripId/status')
  @HttpCode(200)
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async getGenerateStatus(@Param('tripId', ParseIntPipe) tripId: number) {
    const cached = await this.checklists.loadPersistedChecklistItems(BigInt(tripId));
    if (cached && cached.items.length > 0) {
      return { status: 'completed' };
    }
    return { status: 'generating' };
  }

  /**
   * Trip 레코드 없이도 맞춤 체크리스트를 생성한다.
   * 프론트의 여행 계획 플로우 중(아직 trip DB 저장 전) "/trips/:id/search" 에서
   * 바로 호출할 수 있도록 컨텍스트를 바디로 받는 변형 엔드포인트.
   *
   *   POST /api/checklists/generate-from-context
   *   Body: { destination, durationDays, season?, tripStart?, companions?, purposes? }
   */
  @Public()
  @Post('generate-from-context')
  @HttpCode(200)
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  generateFromContext(@Body() dto: GenerateFromContextDto) {
    const season = dto.season?.trim()
      ? dto.season
      : dto.tripStart
        ? this.inferSeason(new Date(dto.tripStart))
        : '봄';
    const travelMonth = dto.tripStart
      ? new Date(dto.tripStart).getMonth() + 1
      : new Date().getMonth() + 1;
    return this.checklists.generateFromContext({
      destination: dto.destination,
      durationDays: dto.durationDays,
      season,
      travelMonth,
      companions: dto.companions ?? [],
      purposes: dto.purposes ?? [],
    });
  }

  private inferSeason(date: Date): string {
    if (isNaN(date.getTime())) return '봄';
    const month = date.getMonth() + 1;
    if (month >= 3 && month <= 5) return '봄';
    if (month >= 6 && month <= 8) return '여름';
    if (month >= 9 && month <= 11) return '가을';
    return '겨울';
  }

  // ===========================================================
  // 체크리스트 영속화 / 편집 / 체크 엔드포인트
  //
  // 프론트가 guideArchiveStorage / savedTripItems (localStorage) 에
  // 들고 있던 상태를 서버로 이전하는 API 들.
  // 모든 변경은 `ChecklistItemEdit` / `ChecklistItemCheck` 로그 테이블에도 기록된다.
  // ===========================================================

  private requireUserId(user: AuthUser | undefined): bigint {
    if (!user) throw new UnauthorizedException('No session');
    if (user.userId == null) {
      throw new BadRequestException('JIT 프로비저닝이 아직 안 된 세션입니다.');
    }
    return user.userId;
  }

  /**
   * 후보 풀의 항목을 "내 체크리스트" 에 담는다 (is_selected=true).
   *
   *   POST /api/checklists/items/:itemId/select
   */
  @Post('items/:itemId/select')
  @HttpCode(200)
  async selectItem(
    @CurrentUser() user: AuthUser | undefined,
    @Param('itemId', ParseIntPipe) itemId: number,
  ) {
    const userId = this.requireUserId(user);
    const updated = await this.checklistItems.selectItem(BigInt(itemId), userId);
    return {
      id: updated.id.toString(),
      isSelected: updated.isSelected,
      selectedAt: updated.selectedAt?.toISOString() ?? null,
    };
  }

  /**
   * "내 체크리스트" 에서 해당 항목을 뺀다 (is_selected=false). 후보 풀에는 남는다.
   *
   *   POST /api/checklists/items/:itemId/deselect
   */
  @Post('items/:itemId/deselect')
  @HttpCode(200)
  async deselectItem(
    @CurrentUser() user: AuthUser | undefined,
    @Param('itemId', ParseIntPipe) itemId: number,
  ) {
    const userId = this.requireUserId(user);
    const updated = await this.checklistItems.deselectItem(BigInt(itemId), userId);
    return {
      id: updated.id.toString(),
      isSelected: updated.isSelected,
      selectedAt: updated.selectedAt?.toISOString() ?? null,
    };
  }

  /** 체크리스트 아이템 일괄 upsert (title 기준 매칭) */
  @Post('by-trip/:tripId/items')
  @HttpCode(200)
  async upsertItems(
    @CurrentUser() user: AuthUser | undefined,
    @Param('tripId', ParseIntPipe) tripId: number,
    @Body() dto: UpsertItemsDto,
  ) {
    const userId = this.requireUserId(user);
    this.logger.log(
      `upsertItems trip=${tripId} user=${userId} count=${dto.items.length}`,
    );
    return this.checklistItems.upsertItems(BigInt(tripId), userId, dto.items);
  }

  /** 단일 아이템 편집 (title / description / orderIndex) */
  @Patch('items/:itemId')
  async editItem(
    @CurrentUser() user: AuthUser | undefined,
    @Param('itemId', ParseIntPipe) itemId: number,
    @Body() dto: EditItemDto,
  ) {
    const userId = this.requireUserId(user);
    this.logger.log(
      `editItem item=${itemId} user=${userId} keys=${Object.keys(dto).join(',')}`,
    );
    return this.checklistItems.editItem(BigInt(itemId), userId, dto);
  }

  /** 단일 아이템 소프트 삭제 */
  @Delete('items/:itemId')
  @HttpCode(200)
  async deleteItem(
    @CurrentUser() user: AuthUser | undefined,
    @Param('itemId', ParseIntPipe) itemId: number,
  ) {
    const userId = this.requireUserId(user);
    this.logger.log(`deleteItem item=${itemId} user=${userId}`);
    return this.checklistItems.deleteItem(BigInt(itemId), userId);
  }

  /**
   * 가이드 보관함 항목 재분류 (LLM 기반 2차 카테고리 분류).
   *
   *   POST /api/checklists/reclassify-guide-archive
   *   Body: {
   *     tripId?: string,
   *     entryId?: string,
   *     items: [{ id, title, description?, detail?, category?, prepType?, subCategory? }]
   *   }
   *
   *   응답: { model: string | null, items: [{ id, category, subCategory?, confidence? }] }
   *
   * - 인증 가드는 전역 `SupabaseJwtGuard` + `requireUserId` 로 적용 (기존 패턴 유지).
   * - persist 하지 않음 — 결과는 프론트 보관함 스냅샷의 refinedCategory/refinedSubCategory 슬롯에 들어간다.
   * - LLM 호출 실패 시 빈 items[] 로 폴백 (프론트는 base category 를 유지).
   */
  @Post('reclassify-guide-archive')
  @HttpCode(200)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async reclassifyGuideArchive(
    @CurrentUser() user: AuthUser | undefined,
    @Body() dto: ReclassifyGuideArchiveDto,
  ) {
    const userId = this.requireUserId(user);
    this.logger.log(
      `reclassifyGuideArchive trip=${dto.tripId ?? '-'} entry=${dto.entryId ?? '-'} user=${userId} count=${dto.items?.length ?? 0}`,
    );
    return this.checklistItems.reclassifyGuideArchive(dto.items ?? []);
  }

  /** 체크 토글 (checked/unchecked) */
  @Post('items/:itemId/check')
  @HttpCode(200)
  async checkItem(
    @CurrentUser() user: AuthUser | undefined,
    @Param('itemId', ParseIntPipe) itemId: number,
    @Body() dto: CheckItemDto,
  ) {
    const userId = this.requireUserId(user);
    this.logger.log(
      `checkItem item=${itemId} user=${userId} action=${dto.action}`,
    );
    return this.checklistItems.toggleCheck(BigInt(itemId), userId, dto.action);
  }
}
