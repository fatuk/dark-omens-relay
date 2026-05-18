import { Hono }       from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z }          from 'zod';
import { randomUUID } from 'crypto';
import type Anthropic from '@anthropic-ai/sdk';

import { getUserByToken, getCampaign } from '../shared/db.js';
import { logger }         from '../shared/logger.js';
import { getAnthropic, ANTHROPIC_MODEL } from './anthropic.js';
import {
  buildEncounterPrompt, ENCOUNTER_TOOL, DEFAULT_LANGUAGE,
  LOCATION_TYPES, CONDITIONS, ENCOUNTER_KINDS, OTHER_WORLDS,
  type EncounterPromptInput, type CampaignContext,
} from './encounter-prompt.js';

// ── Валидация входа ────────────────────────────────────────────────────────────

const requestSchema = z.object({
  // Вид встречи: general (по умолчанию) | research | gate.
  kind:       z.enum(ENCOUNTER_KINDS).default('general'),
  investigator: z.object({
    name:       z.string().min(1).max(64),
    background: z.string().min(1).max(600),
  }),
  // Реальная локация — для general / research.
  realLocation: z.object({
    name:         z.string().min(1).max(120),
    locationType: z.enum(LOCATION_TYPES),
    flavor:       z.string().max(600).optional(),
  }).optional(),
  // Иной мир за вратами — для kind: "gate".
  otherWorld: z.enum(OTHER_WORLDS).optional(),
  conditions: z.array(z.enum(CONDITIONS)).max(12).default([]),
  count:      z.number().int().min(1).max(5).default(1),
  themeHint:  z.string().max(120).optional(),
  // Язык карточек — название языка ("Russian", "English", "Español", ...).
  language:   z.string().trim().min(2).max(40).default(DEFAULT_LANGUAGE),
  // Контекст кампании. campaignId пусто → встреча самодостаточна (как раньше).
  campaignId: z.string().min(1).max(64).optional(),
  act:        z.number().int().min(1).max(3).default(1),
  doom:       z.number().int().min(0).max(50).optional(),
})
  .refine((v) => v.kind === 'gate' || !!v.realLocation, {
    message: 'realLocation is required for general/research encounters',
    path:    ['realLocation'],
  })
  .refine((v) => v.kind !== 'research' || !!v.campaignId, {
    message: 'campaignId is required for research encounters',
    path:    ['campaignId'],
  });

// Форма сохранённой библии — то, что нужно для среза контекста встречи.
export interface StoredBible {
  ancientOne:  { name: string; epithet: string; description: string };
  theme:       string[];
  doomClock:   number;
  mysteries:   { act: number; title: string; text: string }[];
  escalation:  { act: number; tone: string; worldState: string }[];
  keyNPCs:     { name: string; role: string; allegiance: string }[];
  keyLocations:{ location: string; significance: string }[];
}

// Вынимает из библии компактный срез под текущий акт.
export function extractCampaignContext(
  bible: StoredBible, act: number, doom: number | undefined,
): CampaignContext {
  const mystery    = bible.mysteries.find((m) => m.act === act)  ?? bible.mysteries[0]!;
  const escalation = bible.escalation.find((e) => e.act === act) ?? bible.escalation[0]!;
  return {
    ancientOne: {
      name:        bible.ancientOne.name,
      epithet:     bible.ancientOne.epithet,
      description: bible.ancientOne.description,
    },
    theme:     bible.theme ?? [],
    doomClock: bible.doomClock,
    doom,
    act,
    mystery: { title: mystery.title, text: mystery.text },
    escalation: { tone: escalation.tone, worldState: escalation.worldState },
    keyNPCs:      (bible.keyNPCs ?? []).map((n) => ({ name: n.name, role: n.role, allegiance: n.allegiance })),
    keyLocations: (bible.keyLocations ?? []).map((l) => ({ location: l.location, significance: l.significance })),
  };
}

// ── Генерация (переиспользуется дебаг-эндпоинтом /campaign/preview) ──────────────

/** Прогоняет промпт встречи через LLM, возвращает карточки с проставленными id. */
export async function generateEncounterCards(
  client: Anthropic, promptInput: EncounterPromptInput,
): Promise<Record<string, unknown>[]> {
  const { system, user } = buildEncounterPrompt(promptInput);
  const response = await client.messages.create({
    model:       ANTHROPIC_MODEL,
    max_tokens:  4096,
    // Системный промпт + tool-схема стабильны между вызовами — кешируем
    // (Anthropic prompt caching): срезает обработку входа (TTFT) на префетчах.
    system:      [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    tools:       [ENCOUNTER_TOOL],
    tool_choice: { type: 'tool', name: 'emit_encounters' },
    messages:    [{ role: 'user', content: user }],
  });
  const toolUse = response.content.find((b) => b.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error(`encounter: no tool_use block (stop_reason=${response.stop_reason})`);
  }
  const rawList = (toolUse.input as { encounters?: unknown }).encounters;
  if (!Array.isArray(rawList)) {
    throw new Error('encounter: tool input has no encounters[]');
  }
  // id проставляет сервер — модель его не генерирует.
  return rawList.map((e) => ({ id: randomUUID(), ...(e as Record<string, unknown>) }));
}

// ── Роут ───────────────────────────────────────────────────────────────────────

const encounters = new Hono();

// POST /encounters/generate  →  сгенерировать N карточек встреч под игрока
encounters.post('/generate', zValidator('json', requestSchema), async (c) => {
  // Авторизация: эндпоинт жжёт токены LLM — пускаем только по валидной сессии.
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  const user  = token ? getUserByToken(token) : null;
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const client = getAnthropic();
  if (!client) {
    logger.error('encounter generation requested, but ANTHROPIC_API_KEY is not set');
    return c.json({ error: 'Генерация встреч не настроена на сервере.' }, 503);
  }

  const input = c.req.valid('json');

  // campaignId → подтягиваем сохранённую библию и строим срез контекста.
  let campaignContext: CampaignContext | undefined;
  if (input.campaignId) {
    const row = getCampaign(input.campaignId);
    if (!row) return c.json({ error: 'Кампания не найдена.' }, 404);
    campaignContext = extractCampaignContext(
      JSON.parse(row.json) as StoredBible, input.act, input.doom,
    );
  }

  const promptInput: EncounterPromptInput = {
    kind:         input.kind,
    investigator: input.investigator,
    realLocation: input.realLocation,
    otherWorld:   input.otherWorld,
    conditions:   input.conditions,
    count:        input.count,
    themeHint:    input.themeHint,
    language:     input.language,
    campaign:     campaignContext,
  };

  let cards: Record<string, unknown>[];
  try {
    cards = await generateEncounterCards(client, promptInput);
  } catch (err) {
    logger.error('encounter generation failed', { err: String(err) });
    return c.json({ error: 'Сервис генерации временно недоступен.' }, 502);
  }
  if (cards.length === 0) {
    logger.error('encounter generation returned no cards');
    return c.json({ error: 'Модель не вернула ни одной карточки.' }, 502);
  }

  logger.info('encounters generated', {
    userId:     user.id,
    kind:       input.kind,
    count:      cards.length,
    place:      input.realLocation?.name ?? input.otherWorld ?? null,
    campaignId: input.campaignId ?? null,
  });

  return c.json({ ok: true, encounters: cards });
});

export { encounters };
