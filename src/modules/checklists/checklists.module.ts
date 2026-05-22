import { Module } from '@nestjs/common';
import { ChecklistsController } from './checklists.controller';
import { ChecklistsService } from './checklists.service';
import { ChecklistItemService } from './checklist-item.service';
import { LlmModule } from '../llm/llm.module';

@Module({
  imports: [LlmModule],
  controllers: [ChecklistsController],
  providers: [ChecklistsService, ChecklistItemService],
  exports: [ChecklistsService, ChecklistItemService],
})
export class ChecklistsModule {}
