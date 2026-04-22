import { Module } from '@nestjs/common';
import { GuideArchivesController } from './guide-archives.controller';
import { GuideArchivesService } from './guide-archives.service';

@Module({
  controllers: [GuideArchivesController],
  providers: [GuideArchivesService],
  exports: [GuideArchivesService],
})
export class GuideArchivesModule {}
