import { Controller, Get, Param, ParseIntPipe } from '@nestjs/common';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get(':id')
  async getOne(@Param('id', ParseIntPipe) id: number) {
    return this.users.requireById(BigInt(id));
  }
}
