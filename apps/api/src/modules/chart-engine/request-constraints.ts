import { fieldMatchScore } from './chart-planner';
import type {
  EngineChartSpec,
  EngineSpecFilter,
  SemanticModel,
} from './semantic-model.types';

export type EnginePeriod =
  | { kind: 'MTD' | 'QTD' | 'YTD' }
  | {
      kind:
        | 'LAST_N_DAYS'
        | 'LAST_N_WEEKS'
        | 'LAST_N_MONTHS'
        | 'LAST_N_QUARTERS'
        | 'LAST_N_YEARS';
      value: number;
    };

export interface RequestConstraints {
  dateRange?: { start: string; end: string };
  period?: EnginePeriod;
  topN?: number;
  sort?: 'asc' | 'desc';
  filters: EngineSpecFilter[];
  requiresTimeAxis: boolean;
  timeGrain?: 'day' | 'month' | 'quarter' | 'year';
}

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};

const iso = (year: number, month: number, day: number) =>
  `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

const lastDay = (year: number, month: number) =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

function parseCount(raw: string): number | null {
  const numeric = Number(raw);
  if (Number.isInteger(numeric) && numeric > 0) return numeric;
  return NUMBER_WORDS[raw.toLowerCase()] ?? null;
}

function parseDateConstraint(
  question: string,
): Pick<RequestConstraints, 'dateRange' | 'period'> {
  const q = question.toLowerCase();
  const quarter = q.match(/\bq([1-4])\s*(?:of\s+)?((?:19|20)\d{2})\b/);
  if (quarter) {
    const quarterNumber = Number(quarter[1]);
    const year = Number(quarter[2]);
    const startMonth = (quarterNumber - 1) * 3 + 1;
    const endMonth = startMonth + 2;
    return {
      dateRange: {
        start: iso(year, startMonth, 1),
        end: iso(year, endMonth, lastDay(year, endMonth)),
      },
    };
  }

  const half = q.match(
    /\b(?:(first|second)\s+half|h([12]))(?:\s+of)?\s+((?:19|20)\d{2})\b/,
  );
  if (half) {
    const year = Number(half[3]);
    const first = half[1] === 'first' || half[2] === '1';
    return {
      dateRange: {
        start: iso(year, first ? 1 : 7, 1),
        end: iso(year, first ? 6 : 12, first ? 30 : 31),
      },
    };
  }

  const monthRange = q.match(
    /\b(?:from\s+)?([a-z]{3,9})\s+(?:through|thru|to|until|[-–])\s+([a-z]{3,9})\s+((?:19|20)\d{2})\b/,
  );
  if (monthRange) {
    const startMonth = MONTHS[monthRange[1]!];
    const endMonth = MONTHS[monthRange[2]!];
    const year = Number(monthRange[3]);
    if (startMonth && endMonth) {
      return {
        dateRange: {
          start: iso(year, startMonth, 1),
          end: iso(year, endMonth, lastDay(year, endMonth)),
        },
      };
    }
  }

  if (/\bmtd\b|\bmonth[\s-]*to[\s-]*date\b/.test(q))
    return { period: { kind: 'MTD' } };
  if (/\bqtd\b|\bquarter[\s-]*to[\s-]*date\b/.test(q))
    return { period: { kind: 'QTD' } };
  if (/\bytd\b|\byear[\s-]*to[\s-]*date\b/.test(q))
    return { period: { kind: 'YTD' } };

  const relative = q.match(
    /\b(?:last|past|previous|trailing)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(day|week|month|quarter|year)s?\b/,
  );
  if (relative) {
    const value = parseCount(relative[1]!);
    const unit = relative[2]!;
    if (value) {
      const suffix = unit.toUpperCase() as
        | 'DAY'
        | 'WEEK'
        | 'MONTH'
        | 'QUARTER'
        | 'YEAR';
      return {
        period: {
          kind: `LAST_N_${suffix}S`,
          value,
        } as EnginePeriod,
      };
    }
  }

  const years = Array.from(q.matchAll(/\b((?:19|20)\d{2})\b/g), (m) =>
    Number(m[1]),
  );
  const isComparison =
    /\b(?:vs\.?|versus|compare|comparison|year[\s-]*over[\s-]*year|yoy|by\s+year|each\s+year|annual\s+trend)\b/.test(
      q,
    );
  if (years.length === 1 && !isComparison) {
    const year = years[0]!;
    return {
      dateRange: {
        start: iso(year, 1, 1),
        end: iso(year, 12, 31),
      },
    };
  }
  return {};
}

function extractFilters(
  question: string,
  model: SemanticModel,
): EngineSpecFilter[] {
  const q = question.toLocaleLowerCase();
  const filters: EngineSpecFilter[] = [];
  const measurePhrases = model.measures.flatMap((measure) =>
    [measure.key, measure.label]
      .map((value) =>
        value
          .toLocaleLowerCase()
          .replace(/[^a-z0-9]+/g, ' ')
          .trim(),
      )
      .filter(Boolean),
  );
  const commaCount = (q.match(/,/g) ?? []).length;
  for (const dimension of model.dimensions) {
    const values = (dimension.sampleValues ?? [])
      .map(String)
      .map((value) => value.trim())
      .filter((value) => {
        if (value.length < 3) return false;
        const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = new RegExp(
          `(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`,
          'i',
        ).exec(q);
        if (!match) return false;

        // A sample member can share its text with a measure (for example the
        // account-type member "Revenue" and the measure "Total Revenue").
        // In that case the metric mention is not evidence of a categorical
        // filter. The model may still choose a filter when the surrounding
        // language explicitly asks to narrow the result.
        const normalizedValue = value
          .toLocaleLowerCase()
          .replace(/[^a-z0-9]+/g, ' ')
          .trim();
        const overlapsMentionedMeasure = measurePhrases.some(
          (phrase) =>
            (` ${phrase} `.includes(` ${normalizedValue} `) ||
              ` ${normalizedValue} `.includes(` ${phrase} `)) &&
            ` ${q.replace(/[^a-z0-9]+/g, ' ')} `.includes(
              ` ${normalizedValue} `,
            ),
        );
        const preceding = q.slice(Math.max(0, match.index - 48), match.index);
        const explicitSelection =
          /\b(?:for|where|only|among|excluding|except|include|including)\s+(?:the\s+)?$/i.test(
            preceding,
          );
        if (overlapsMentionedMeasure && !explicitSelection) return false;

        // Lists in visualization requests often describe the components to
        // plot, not a partial member filter. Sample values are intentionally
        // incomplete, so deriving a filter from only the sampled members
        // would silently drop unsampled categories. In an enumerated clause,
        // only apply deterministic filtering when selection language is
        // explicit; otherwise leave semantic interpretation to OpenAI.
        if (commaCount >= 2 && !explicitSelection) return false;
        return true;
      });
    if (values.length) {
      filters.push({
        dimensionKey: dimension.key,
        operator: 'in',
        values: Array.from(new Set(values)),
      });
    }
  }
  const dimensionsByKey = new Map(
    model.dimensions.map((dimension) => [dimension.key, dimension]),
  );
  const normalizedQuestion = q.replace(/[^a-z0-9]+/g, ' ').trim();
  const filterLocations = new Map<string, string[]>();
  for (const filter of filters) {
    for (const value of filter.values) {
      const normalizedValue = String(value)
        .toLocaleLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
      if (!normalizedValue) continue;
      const locations = filterLocations.get(normalizedValue) ?? [];
      locations.push(filter.dimensionKey);
      filterLocations.set(normalizedValue, locations);
    }
  }

  // A member label can legitimately appear in several related dimensions
  // (for example an account name, group, and type can all be "Revenue").
  // Conjoining every sampled match produces an invented, often impossible
  // filter. Keep the match only when the request explicitly names exactly one
  // of those dimensions; otherwise leave the ambiguous member unfiltered.
  for (const [normalizedValue, locations] of filterLocations) {
    const uniqueLocations = Array.from(new Set(locations));
    if (uniqueLocations.length < 2) continue;
    const explicitlyNamed = uniqueLocations.filter((key) => {
      const dimension = dimensionsByKey.get(key);
      if (!dimension) return false;
      return [dimension.key, dimension.label].some((candidate) => {
        const phrase = candidate
          .toLocaleLowerCase()
          .replace(/[^a-z0-9]+/g, ' ')
          .trim();
        return phrase.length > 1 && ` ${normalizedQuestion} `.includes(` ${phrase} `);
      });
    });
    for (const filter of filters) {
      if (!uniqueLocations.includes(filter.dimensionKey)) continue;
      if (
        explicitlyNamed.length === 1 &&
        explicitlyNamed[0] === filter.dimensionKey
      )
        continue;
      filter.values = filter.values.filter(
        (value) =>
          String(value)
            .toLocaleLowerCase()
            .replace(/[^a-z0-9]+/g, ' ')
            .trim() !== normalizedValue,
      );
    }
  }
  return filters.filter((filter) => filter.values.length > 0);
}

export function extractRequestConstraints(
  question: string,
  model: SemanticModel,
): RequestConstraints {
  const q = question.toLowerCase();
  const calendarConstraint = parseDateConstraint(question);
  const top = q.match(
    /\b(?:top|bottom)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b|\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+(?:largest|smallest|highest|lowest)\b/,
  );
  const topN = top ? parseCount(top[1] ?? top[2] ?? '') : null;
  const sort: 'asc' | 'desc' | undefined =
    /\b(?:ascending|asc|smallest|lowest|bottom)\b/.test(q)
      ? 'asc'
      : /\b(?:descending|desc|largest|highest|top)\b/.test(q)
        ? 'desc'
        : undefined;
  const timeGrain = (() => {
    if (/\bfiscal\s+years?\b/.test(q)) return 'year' as const;
    const explicit = q.match(
      /\b(?:by|per|each)\s+(?:slice\s+(?:is|represents?)\s+(?:one\s+)?)?(day|week|month|quarter|year)\b|\b(daily|weekly|monthly|quarterly|annually|yearly)\b|\b(day|week|month|quarter|year)[\s-]*by[\s-]*\3\b/,
    );
    const raw = explicit?.[1] ?? explicit?.[2] ?? explicit?.[3];
    if (!raw) return undefined;
    if (/^day/.test(raw)) return 'day' as const;
    if (/^week/.test(raw)) return 'day' as const;
    if (/^month/.test(raw)) return 'month' as const;
    if (/^quarter/.test(raw)) return 'quarter' as const;
    return 'year' as const;
  })();
  const sliceGrain = q.match(
    /\beach\s+slice\s+(?:is|represents?)\s+(?:one\s+)?(day|week|month|quarter|year)\b/,
  )?.[1];
  const normalizedTimeGrain = sliceGrain
    ? sliceGrain === 'week'
      ? ('day' as const)
      : (sliceGrain as 'day' | 'month' | 'quarter' | 'year')
    : timeGrain;
  const requestsTemporalChart =
    /\b(?:line|area)\s+(?:chart|graph)\b|\btime[\s-]*series\b/.test(q);
  const inferredWindowGrain = (() => {
    if (!requestsTemporalChart || !model.time) return undefined;
    if (calendarConstraint.period) {
      const grain =
        calendarConstraint.period.kind === 'LAST_N_DAYS' ||
        calendarConstraint.period.kind === 'LAST_N_WEEKS'
          ? ('day' as const)
          : calendarConstraint.period.kind === 'LAST_N_MONTHS' ||
              calendarConstraint.period.kind === 'MTD'
            ? ('month' as const)
            : calendarConstraint.period.kind === 'LAST_N_QUARTERS' ||
                calendarConstraint.period.kind === 'QTD'
              ? ('quarter' as const)
              : ('year' as const);
      return model.time.grains.includes(grain) ? grain : undefined;
    }
    if (calendarConstraint.dateRange) {
      return model.time.grains.includes('month')
        ? ('month' as const)
        : undefined;
    }
    return undefined;
  })();
  const effectiveTimeGrain = normalizedTimeGrain ?? inferredWindowGrain;
  const requiresTimeAxis =
    !!effectiveTimeGrain || /\b(?:trend|over\s+time)\b/.test(q);
  return {
    ...calendarConstraint,
    ...(topN ? { topN: Math.min(topN, 500) } : {}),
    ...(sort ? { sort } : {}),
    filters: extractFilters(question, model),
    requiresTimeAxis,
    ...(effectiveTimeGrain ? { timeGrain: effectiveTimeGrain } : {}),
  };
}

export function applyRequestConstraints(
  question: string,
  spec: EngineChartSpec,
  model: SemanticModel,
  options: {
    preserveTimeAxis?: boolean;
    preserveNormalization?: boolean;
  } = {},
): EngineChartSpec {
  const constraints = extractRequestConstraints(question, model);
  // Deterministic extraction intentionally avoids inferring filters from a
  // partial sample of an enumerated member list. A planner-authored filter is
  // different: it is the model's grounded interpretation of the complete
  // request and must survive constraint application.
  const plannerFilters = spec.filters ?? [];
  const next: EngineChartSpec = {
    ...spec,
    ...(spec.filters ? { filters: plannerFilters } : {}),
    ...(constraints.dateRange ? { dateRange: constraints.dateRange } : {}),
    ...(constraints.period ? { period: constraints.period } : {}),
    ...(constraints.topN ? { topN: constraints.topN } : {}),
    ...(constraints.sort ? { sort: constraints.sort } : {}),
    ...(constraints.timeGrain ? { timeGrain: constraints.timeGrain } : {}),
    ...(constraints.filters.length
      ? {
          filters: [
            ...plannerFilters.filter(
              (existing) =>
                !constraints.filters.some(
                  (nextFilter) =>
                    nextFilter.dimensionKey === existing.dimensionKey,
                ),
            ),
            ...constraints.filters,
          ],
        }
      : {}),
  };
  const explicitlyRequestsNormalization =
    /\b(?:share|percentage|percent)\s+of\s+(?:the\s+)?total\b|\b100\s*%\s*stacked\b|\bnormalize(?:d)?\b/i.test(
      question,
    );
  if (
    next.normalize &&
    !explicitlyRequestsNormalization &&
    !options.preserveNormalization
  )
    delete next.normalize;
  if (
    next.timeGrain &&
    !constraints.requiresTimeAxis &&
    !next.comparison &&
    !options.preserveTimeAxis
  )
    delete next.timeGrain;
  return next;
}

export function validateRequestFidelity(
  question: string,
  spec: EngineChartSpec,
  model: SemanticModel,
): string | null {
  const arithmetic = question.match(
    /\b(.+?)\s+(?:minus|less|subtract(?:ed\s+from)?|difference\s+between)\s+(.+?)(?:\s+(?:by|for|during|in|from|as)\b|[.?!]|$)/i,
  );
  if (arithmetic) {
    return 'requested arithmetic is not explicitly represented by the chart specification';
  }

  const questionMentionsCatalogMeasure = model.measures.some(
    (measure) => fieldMatchScore(question, measure.key, measure.label) > 0,
  );
  const selectedMeasureIsRelevant = spec.measureKeys.some((key) => {
    const measure = model.measures.find((item) => item.key === key);
    return (
      !!measure && fieldMatchScore(question, measure.key, measure.label) > 0
    );
  });
  if (questionMentionsCatalogMeasure && !selectedMeasureIsRelevant)
    return 'selected measures do not match the requested metric';
  return null;
}

export function validateChartRows(
  spec: EngineChartSpec,
  rows: Array<Record<string, unknown>>,
): string | null {
  if (!rows.length) return 'query returned no rows';
  if (
    spec.timeGrain &&
    ['line', 'area', 'stacked_area'].includes(spec.chartType) &&
    rows.length < 2
  )
    return 'time-series chart requires at least two period points';
  if (spec.topN && !spec.timeGrain && rows.length > spec.topN)
    return `query returned ${rows.length} categories for a top-${spec.topN} request`;
  if (spec.chartType === 'pie' || spec.chartType === 'donut') {
    const numericValues = rows.flatMap((row) =>
      Object.entries(row)
        .filter(
          ([key, value]) => key !== 'name' && Number.isFinite(Number(value)),
        )
        .map(([, value]) => Number(value)),
    );
    if (!numericValues.length)
      return 'part-to-whole chart has no numeric values';
    if (numericValues.some((value) => value < 0))
      return 'part-to-whole charts cannot contain negative values';
  }
  return null;
}
