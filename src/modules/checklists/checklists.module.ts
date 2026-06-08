import { Module } from '@nestjs/common';
import { ChecklistsController } from './checklists.controller';
import { ChecklistsService } from './checklists.service';
import { ChecklistItemService } from './checklist-item.service';
import { LlmModule } from '../llm/llm.module';
import { TripsModule } from '../trips/trips.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [LlmModule, TripsModule, NotificationsModule],
  controllers: [ChecklistsController],
  providers: [ChecklistsService, ChecklistItemService],
  exports: [ChecklistsService, ChecklistItemService],
})
export class ChecklistsModule {}
