import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { TripsService } from './trips.service';
import { CreateTripDto } from './dto/create-trip.dto';
import { UpdateTripDto } from './dto/update-trip.dto';
import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';

@Controller('trips')
export class TripsController {
  constructor(private readonly trips: TripsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser | undefined,
    @Query('userId') rawUserId?: string,
  ) {
    // JWT 에서 userId 를 꺼내되, 레거시 호출(userId 쿼리) 도 허용.
    const fromJwt = user?.userId ? Number(user.userId) : null;
    const fromQuery = rawUserId ? Number(rawUserId) : null;
    const resolved = fromJwt ?? fromQuery;
    if (!resolved || Number.isNaN(resolved)) {
      throw new BadRequestException('userId 를 확인할 수 없습니다. 로그인 상태를 확인하세요.');
    }
    return this.trips.listByUser(BigInt(resolved));
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.trips.findOne(BigInt(id));
  }

  /**
   * 여행 계획 생성. `userId` 는 항상 JWT 의 `req.user.userId` 로 덮어써서
   * 바디에 들어온 값은 무시한다 (다른 사람 userId 로 생성 방지).
   */
  @Post()
  @HttpCode(201)
  create(
    @CurrentUser() user: AuthUser | undefined,
    @Body() dto: CreateTripDto,
  ) {
    if (!user) throw new UnauthorizedException('No session');
    if (user.userId == null) {
      throw new BadRequestException(
        'JIT 프로비저닝이 아직 안 된 세션입니다. 소셜 로그인 후 다시 시도하세요.',
      );
    }
    const authoritative: CreateTripDto = {
      ...dto,
      userId: Number(user.userId),
    };
    return this.trips.create(authoritative);
  }

  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateTripDto) {
    return this.trips.update(BigInt(id), dto);
  }

  @Delete(':id')
  @HttpCode(200)
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.trips.softDelete(BigInt(id));
  }
}
