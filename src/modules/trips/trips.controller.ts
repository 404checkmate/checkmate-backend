import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { TripsService } from './trips.service';

@Controller('trips')
export class TripsController {
  constructor(private readonly trips: TripsService) {}

  @Get()
  list(@Query('userId', ParseIntPipe) userId: number) {
    return this.trips.listByUser(BigInt(userId));
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.trips.findOne(BigInt(id));
  }
}
