import { Controller, Get, Param, ParseIntPipe } from '@nestjs/common';
import { ChecklistsService } from './checklists.service';

@Controller('checklists')
export class ChecklistsController {
  constructor(private readonly checklists: ChecklistsService) {}

  @Get('by-trip/:tripId')
  byTrip(@Param('tripId', ParseIntPipe) tripId: number) {
    return this.checklists.getByTrip(BigInt(tripId));
  }
}
