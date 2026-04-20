import { Body, Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { LlmService, LlmPromptInput } from './llm.service';

@Controller('llm')
export class LlmController {
  constructor(private readonly llm: LlmService) {}

  @Post('trips/:tripId/generate')
  generate(
    @Param('tripId', ParseIntPipe) tripId: number,
    @Body() body: LlmPromptInput,
  ) {
    return this.llm.requestChecklist(BigInt(tripId), body);
  }

  @Get('trips/:tripId/generations')
  history(@Param('tripId', ParseIntPipe) tripId: number) {
    return this.llm.listByTrip(BigInt(tripId));
  }
}
