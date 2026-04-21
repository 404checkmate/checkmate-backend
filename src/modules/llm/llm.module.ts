import { Module } from '@nestjs/common';
import { LlmController } from './llm.controller';
import { LlmService } from './llm.service';
import { OpenaiService } from './openai.service';

@Module({
  controllers: [LlmController],
  providers: [LlmService, OpenaiService],
  exports: [LlmService, OpenaiService],
})
export class LlmModule {}
