import { Module } from '@nestjs/common';
import {
  AdminAffiliateLinksController,
  AffiliateLinksController,
} from './affiliate-links.controller';
import { AffiliateLinksService } from './affiliate-links.service';

@Module({
  controllers: [AffiliateLinksController, AdminAffiliateLinksController],
  providers: [AffiliateLinksService],
})
export class AffiliateLinksModule {}
