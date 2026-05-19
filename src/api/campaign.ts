import { Hono }       from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z }          from 'zod';
import { randomUUID } from 'crypto';
import type Anthropic from '@anthropic-ai/sdk';

import {
  getUserByToken, saveCampaign, getCampaign, listCampaigns, deleteCampaign,
} from '../shared/db.js';
import { logger }         from '../shared/logger.js';
import { getAnthropic, ANTHROPIC_MODEL } from './anthropic.js';
import {
  buildCampaignPrompt, CAMPAIGN_TOOL, DEFAULT_LANGUAGE, DEFAULT_PLAYER_COUNT,
  type CampaignPromptInput,
} from './campaign-prompt.js';
import {
  LOCATION_TYPES, type LocationType, type EncounterPromptInput,
} from './encounter-prompt.js';
import {
  generateEncounterCards, extractCampaignContext, type StoredBible,
} from './encounters.js';

// ── Валидация входа ────────────────────────────────────────────────────────────

const locationsSchema = z.array(z.object({
  name: z.string().min(1).max(120),
  type: z.string().min(1).max(40),
})).min(1).max(80);

const generateSchema = z.object({
  locations:   locationsSchema,
  // Конкретный Древний — имя или архетип. Пусто → модель придумывает сама.
  ancientOne:  z.string().trim().min(1).max(200).optional(),
  // Размер партии — под него масштабируются doom-часы и счётчики Мифов.
  playerCount: z.number().int().min(1).max(8).default(DEFAULT_PLAYER_COUNT),
  themeHint:   z.string().max(200).optional(),
  language:    z.string().trim().min(2).max(40).default(DEFAULT_LANGUAGE),
});

// /preview — то же, что /generate, плюс сколько встреч генерить на акт.
const previewSchema = z.object({
  locations:        locationsSchema,
  ancientOne:       z.string().trim().min(1).max(200).optional(),
  playerCount:      z.number().int().min(1).max(8).default(DEFAULT_PLAYER_COUNT),
  themeHint:        z.string().max(200).optional(),
  language:         z.string().trim().min(2).max(40).default(DEFAULT_LANGUAGE),
  encountersPerAct: z.number().int().min(1).max(3).default(1),
});

// Сервер сам проставляет id кампании, мистерий и карт Мифов — модель их не даёт.
function stampCampaignIds(camp: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { id: randomUUID(), ...camp };
  if (Array.isArray(out['mysteries'])) {
    out['mysteries'] = (out['mysteries'] as Record<string, unknown>[])
      .map((m) => ({ id: randomUUID(), ...m }));
  }
  if (Array.isArray(out['mythosDeck'])) {
    out['mythosDeck'] = (out['mythosDeck'] as Record<string, unknown>[])
      .map((card) => ({ id: randomUUID(), ...card }));
  }
  return out;
}

// ── Генерация библии (переиспользуется /generate и /preview) ────────────────────

async function generateCampaignBible(
  client: Anthropic, input: CampaignPromptInput,
): Promise<Record<string, unknown>> {
  const { system, user } = buildCampaignPrompt(input);
  const response = await client.messages.create({
    model:       ANTHROPIC_MODEL,
    max_tokens:  16000,   // целая библия + колода Мифов — крупный JSON
    // Системный промпт + tool-схема стабильны — кешируем (Anthropic prompt caching).
    system:      [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    tools:       [CAMPAIGN_TOOL],
    tool_choice: { type: 'tool', name: 'emit_campaign' },
    messages:    [{ role: 'user', content: user }],
  });
  const toolUse = response.content.find((b) => b.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error(`campaign: no tool_use block (stop_reason=${response.stop_reason})`);
  }
  const raw = (toolUse.input as { campaign?: unknown }).campaign;
  if (!raw || typeof raw !== 'object') {
    throw new Error('campaign: tool input has no campaign object');
  }
  return stampCampaignIds(raw as Record<string, unknown>);
}

// ── Роуты ──────────────────────────────────────────────────────────────────────

const campaign = new Hono();

// POST /campaign/generate  →  сгенерировать и сохранить сценарную библию
campaign.post('/generate', zValidator('json', generateSchema), async (c) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  const user  = token ? getUserByToken(token) : null;
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const client = getAnthropic();
  if (!client) {
    logger.error('campaign generation requested, but ANTHROPIC_API_KEY is not set');
    return c.json({ error: 'Генерация кампании не настроена на сервере.' }, 503);
  }

  let result: Record<string, unknown>;
  try {
    result = await generateCampaignBible(client, c.req.valid('json'));
  } catch (err) {
    logger.error('campaign generation failed', { err: String(err) });
    return c.json({ error: 'Сервис генерации временно недоступен.' }, 502);
  }

  const campaignId = String(result['id']);
  saveCampaign(campaignId, user.id, JSON.stringify(result));
  logger.info('campaign generated', {
    userId: user.id, id: campaignId, title: result['title'],
    mythos: Array.isArray(result['mythosDeck']) ? result['mythosDeck'].length : 0,
  });

  return c.json({ ok: true, campaign: result });
});


// POST /campaign/preview  →  ДЕБАГ: библия + выборка встреч по актам, одним JSON
campaign.post('/preview', zValidator('json', previewSchema), async (c) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  const user  = token ? getUserByToken(token) : null;
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const client = getAnthropic();
  if (!client) {
    logger.error('campaign preview requested, but ANTHROPIC_API_KEY is not set');
    return c.json({ error: 'Генерация кампании не настроена на сервере.' }, 503);
  }

  const input = c.req.valid('json');

  let bible: Record<string, unknown>;
  try {
    bible = await generateCampaignBible(client, input);
  } catch (err) {
    logger.error('campaign preview: bible generation failed', { err: String(err) });
    return c.json({ error: 'Сервис генерации временно недоступен.' }, 502);
  }
  saveCampaign(String(bible['id']), user.id, JSON.stringify(bible));

  // Для каждого акта — выборка встреч у одной из ключевых локаций (параллельно).
  const typed = bible as unknown as StoredBible;
  const tasks = [1, 2, 3].map(async (act) => {
    const ctx = extractCampaignContext(typed, act, undefined);
    const kl  = typed.keyLocations[(act - 1) % typed.keyLocations.length]!;
    const rawType = input.locations.find((l) => l.name === kl.location)?.type ?? 'city';
    const locType: LocationType =
      (LOCATION_TYPES as readonly string[]).includes(rawType) ? rawType as LocationType : 'city';
    const promptInput: EncounterPromptInput = {
      kind:         'research',
      investigator: {
        name:       'Странствующий сыщик',
        background: 'исследователь оккультного, идущий по следу кошмара',
      },
      realLocation: { name: kl.location, locationType: locType },
      conditions:   [],
      count:        input.encountersPerAct,
      language:     input.language,
      campaign:     ctx,
    };
    try {
      const cards = await generateEncounterCards(client, promptInput);
      return { act, location: kl.location, encounters: cards };
    } catch (err) {
      logger.error('campaign preview: encounter generation failed', { act, err: String(err) });
      return { act, location: kl.location, encounters: [] as Record<string, unknown>[] };
    }
  });
  const preview = await Promise.all(tasks);

  logger.info('campaign preview generated', {
    userId:     user.id,
    id:         bible['id'],
    encounters: preview.reduce((n, p) => n + p.encounters.length, 0),
  });

  return c.json({ ok: true, campaign: bible, preview });
});


// GET /campaign  →  список всех кампаний (метаданные, без json-блоба)
campaign.get('/', (c) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  const user  = token ? getUserByToken(token) : null;
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const campaigns = listCampaigns();
  return c.json({ ok: true, count: campaigns.length, campaigns });
});


// GET /campaign/:id  →  достать сохранённую сценарную библию
campaign.get('/:id', (c) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  const user  = token ? getUserByToken(token) : null;
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const row = getCampaign(c.req.param('id'));
  if (!row) return c.json({ error: 'Кампания не найдена.' }, 404);

  return c.json({ ok: true, campaign: JSON.parse(row.json) });
});


// DELETE /campaign/:id  →  удалить сохранённую кампанию
campaign.delete('/:id', (c) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  const user  = token ? getUserByToken(token) : null;
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const id = c.req.param('id');
  if (!deleteCampaign(id)) return c.json({ error: 'Кампания не найдена.' }, 404);

  logger.info('campaign deleted', { userId: user.id, id });
  return c.json({ ok: true });
});

export { campaign };
