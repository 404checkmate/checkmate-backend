import { Controller, Get, HttpCode, Param, ParseIntPipe, Post } from '@nestjs/common';
import { ChecklistsService } from './checklists.service';

@Controller('checklists')
export class ChecklistsController {
  constructor(private readonly checklists: ChecklistsService) {}

  @Get('by-trip/:tripId')
  byTrip(@Param('tripId', ParseIntPipe) tripId: number) {
    return this.checklists.getByTrip(BigInt(tripId));
  }

  /**
   * 맞춤형 체크리스트 생성 (기본 준비물 + OpenAI 추가 추천 Merge).
   *
   *   POST /api/checklists/generate/:tripId
   *
   * - 기본 준비물은 DB(ChecklistItemTemplate)에서 로드
   * - 추가 물품은 OpenAI(gpt-4o-mini)가 여행 컨텍스트 기반으로 JSON 반환
   * - 두 결과를 중복 없이 합쳐서 카테고리별로 그룹핑한 JSON 을 응답
   *
   * (영속화는 수행하지 않음 — 프론트에서 확인/수정 후 저장용 엔드포인트를 별도 호출하도록 분리)
   */
  @Post('generate/:tripId')
  @HttpCode(200)
  generate(@Param('tripId', ParseIntPipe) tripId: number) {
    return this.checklists.generateForTrip(BigInt(tripId));
  }
}
