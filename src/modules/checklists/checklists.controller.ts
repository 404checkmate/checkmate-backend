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
import {
  AuthUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { ChecklistsService } from './checklists.service';
import { GenerateFromContextDto } from './dto/generate-from-context.dto';
import {
  CheckItemDto,
  EditItemDto,
  UpsertItemsDto,
} from './dto/upsert-items.dto';

@Controller('checklists')
export class ChecklistsController {
  private readonly logger = new Logger(ChecklistsController.name);

  constructor(private readonly checklists: ChecklistsService) {}

  @Get('by-trip/:tripId')
  byTrip(@Param('tripId', ParseIntPipe) tripId: number) {
    return this.checklists.getByTrip(BigInt(tripId));
  }

  /**
   * 후보 풀 조회 — 영속화된 ChecklistItem 전부를 `GeneratedChecklist` 형태로 돌려준다.
   * 아직 생성된 적이 없으면 404 — 먼저 POST /generate/:tripId 를 호출해야 한다.
   *
   *   GET /api/checklists/by-trip/:tripId/candidates
   */
  @Get('by-trip/:tripId/candidates')
  listCandidates(@Param('tripId', ParseIntPipe) tripId: number) {
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
  @HttpCode(200)
  generate(@Param('tripId', ParseIntPipe) tripId: number) {
    return this.checklists.generateForTrip(BigInt(tripId));
  }

  /**
   * Trip 레코드 없이도 맞춤 체크리스트를 생성한다.
   * 프론트의 여행 계획 플로우 중(아직 trip DB 저장 전) "/trips/:id/search" 에서
   * 바로 호출할 수 있도록 컨텍스트를 바디로 받는 변형 엔드포인트.
   *
   *   POST /api/checklists/generate-from-context
   *   Body: { destination, durationDays, season?, tripStart?, companions?, purposes? }
   */
  @Post('generate-from-context')
  @HttpCode(200)
  generateFromContext(@Body() dto: GenerateFromContextDto) {
    const season = dto.season?.trim()
      ? dto.season
      : dto.tripStart
        ? this.inferSeason(new Date(dto.tripStart))
        : '봄';
    return this.checklists.generateFromContext({
      destination: dto.destination,
      durationDays: dto.durationDays,
      season,
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
  async selectItem(@Param('itemId', ParseIntPipe) itemId: number) {
    const updated = await this.checklists.selectItem(BigInt(itemId));
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
  async deselectItem(@Param('itemId', ParseIntPipe) itemId: number) {
    const updated = await this.checklists.deselectItem(BigInt(itemId));
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
    return this.checklists.upsertItems(BigInt(tripId), userId, dto.items);
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
    return this.checklists.editItem(BigInt(itemId), userId, dto);
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
    return this.checklists.deleteItem(BigInt(itemId), userId);
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
    return this.checklists.toggleCheck(BigInt(itemId), userId, dto.action);
  }
}
