import { Module } from '@nestjs/common';
import { TripsController } from './trips.controller';
import { TripsService } from './trips.service';
import { TripAccessService } from './trip-access.service';
import { TripMembersController } from './trip-members.controller';
import { TripMembersService } from './trip-members.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  // TripMembersController 를 먼저 등록 — `GET trips/invites/:token` 이
  // TripsController 의 `GET trips/:id` 보다 먼저 매칭되어야 함
  controllers: [TripMembersController, TripsController],
  providers: [TripsService, TripAccessService, TripMembersService],
  exports: [TripsService, TripAccessService, TripMembersService],
})
export class TripsModule {}
