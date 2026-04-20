import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../infra/prisma/prisma.service';

export interface LlmPromptInput {
  countryCode: string;
  cityCodes: string[];
  companions: string[];
  styles: string[];
  durationDays: number;
  tripStart: string;
  tripEnd: string;
  [key: string]: unknown;
}

/**
 * LLM 호출 오케스트레이션.
 *
 * TODO(next PR): 실제 LLM 호출은 BullMQ 큐 워커에서 수행하고,
 *                이 서비스는 요청을 queue enqueue + `llm_generations` 레코드 생성만 담당.
 */
@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async requestChecklist(tripId: bigint, input: LlmPromptInput) {
    const model = this.config.get<string>('llm.model', 'gpt-4o-mini');
    const row = await this.prisma.llmGeneration.create({
      data: {
        tripId,
        promptInput: input as unknown as Prisma.InputJsonValue,
        model,
        status: 'pending',
      },
    });
    this.logger.log(`llm_generation queued id=${row.id} trip=${tripId} model=${model}`);
    return row;
  }

  listByTrip(tripId: bigint) {
    return this.prisma.llmGeneration.findMany({
      where: { tripId },
      orderBy: { generatedAt: 'desc' },
    });
  }
}
