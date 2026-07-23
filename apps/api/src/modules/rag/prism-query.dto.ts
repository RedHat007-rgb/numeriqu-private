import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PRISM_TONES, type PrismTone } from './prism-policy';

export class PrismQueryDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4_000)
  query!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  sessionId?: string;

  @IsOptional()
  @IsIn(PRISM_TONES)
  tone?: PrismTone;
}
