import { Controller, Get, Query } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { MasterService } from './master.service';

@Controller('master')
@Public()
export class MasterController {
  constructor(private readonly master: MasterService) {}

  @Get('countries')
  countries() {
    return this.master.listCountries();
  }

  @Get('cities')
  cities(@Query('countryId') countryId?: string, @Query('onlyServed') onlyServed?: string) {
    return this.master.listCities(
      countryId ? BigInt(countryId) : undefined,
      onlyServed === 'true',
    );
  }

  @Get('checklist-categories')
  categories() {
    return this.master.listChecklistCategories();
  }

  @Get('travel-styles')
  styles() {
    return this.master.listTravelStyles();
  }

  @Get('companion-types')
  companions() {
    return this.master.listCompanionTypes();
  }
}
