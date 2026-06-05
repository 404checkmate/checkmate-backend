import { Module } from '@nestjs/common';
import { GuideArchivesController } from './guide-archives.controller';
import { GuideArchivesService } from './guide-archives.service';
import { TripsModule } from '../trips/trips.module';

@Module({
  imports: [TripsModule],
  controllers: [GuideArchivesController],
  providers: [GuideArchivesService],
  exports: [GuideArchivesService],
})
export class GuideArchivesModule {}
