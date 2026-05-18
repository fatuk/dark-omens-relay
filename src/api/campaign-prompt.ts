import type Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_LANGUAGE } from './encounter-prompt.js';
import {
  EFFECT_REF, EFFECT_DEF_NAME, effectJsonDef,
  MYSTERY_TRIGGERS, MYSTERY_SOLVE_KINDS,
} from './effect-dsl.js';

export { DEFAULT_LANGUAGE };

/**
 * Промпт для генерации сценарной библии кампании — каркас, под который потом
 * генерятся встречи и карты Мифов: Древний, цепочка Мистерий, NPC, локации,
 * эскалация, круг знамений, колода Мифов.
 *
 * buildCampaignPrompt({...}) → { system, user }.
 * CAMPAIGN_TOOL — JSON-схема tool use (модель обязана вернуть валидный JSON).
 */

// ── Вход билдера ───────────────────────────────────────────────────────────────

export interface CampaignLocation {
  /** Реальное название локации, как на игровой карте. */
  name: string;
  /** Тип локации: city | wilderness | sea. */
  type: string;
}

export interface CampaignPromptInput {
  /** Локации игровой карты — сценарий цепляет ключевые точки за реальные. */
  locations: CampaignLocation[];
  /** Язык текста кампании ("Russian", "English", ...). */
  language?: string;
  /** Опциональная подсказка по тону/сеттингу. */
  themeHint?: string;
  /** Конкретный Древний — имя или архетип. Пусто → модель придумывает сама. */
  ancientOne?: string;
  /** Размер партии (число сыщиков) — под него масштабируются doom и счётчики. */
  playerCount?: number;
}

/** Размер партии по умолчанию, если не передан. */
export const DEFAULT_PLAYER_COUNT = 4;

/** В кампании ровно столько Мистерий (акты 1/2/3). */
export const CAMPAIGN_MYSTERY_COUNT = 3;

// ── System prompt ──────────────────────────────────────────────────────────────

export function buildCampaignSystemPrompt(language: string): string {
  return `
You are the lead scenario designer for a Lovecraftian pulp-horror investigator
board game in the spirit of Eldritch Horror / Arkham Horror. Your task: design
one complete CAMPAIGN — a scenario "bible" that every encounter and Mythos card
of a single playthrough is built from. You write in ${language}. You output
JSON only, via the emit_campaign tool.

## The campaign is the spine
A playthrough = investigators racing to solve a chain of Mysteries before the
Ancient One awakens. Everything you design serves that one spine: one cosmic
threat, one escalating mystery chain, one doom clock. Make the pieces cohere —
NPCs, locations, mysteries and Mythos cards must all clearly belong to the
same story.

## Tone
1920s–1930s weird-tales cosmic horror. Concise, evocative, dry — Lovecraft /
Hodgson / Blackwood, not YA fantasy. No melodrama. Cosmic dread, not gore.

## Pieces of the bible

### ancientOne
The central cosmic threat. \`name\`, \`epithet\`, \`description\` (its nature —
what it is), \`awakening\` (what becomes of the world if the doom clock runs
out). This sets the theme of EVERYTHING else.
If the user message names an Ancient One, you MUST build the campaign around
it: keep a proper name exactly as given; if it is only an archetype or a
description, design a fitting Ancient One from it. If none is given, invent one.

### doomClock
Integer — the doom value at which the Ancient One awakens. The campaign-length
knob. Doom does NOT tick on a fixed schedule — it jumps when the omen advances
onto open gates (see Mythos). 8–14 is a normal-length campaign.

### Party scale
The user message states the party size (number of investigators). Scale to it:
a larger party → a somewhat longer \`doomClock\` and larger \`count\` values on
Mythos effects (openGate, spawnMonster, placeClue); a smaller party → tighter
numbers. A 1–2 investigator party is fragile; a party of 5+ is a war council.

### theme & omenSymbols
\`theme\` — 2–6 tone keywords. \`omenSymbols\` — 3–4 evocative symbols themed to
the Ancient One, forming the "omen wheel" a token is moved around (e.g. for a
sea horror: «Прилив», «Шёпот», «Затмение»).

### mysteries — the chain (exactly 3)
Three Mysteries, acts 1 → 2 → 3, an ESCALATING chain:
- Act 1 establishes the threat — first contact, the wrongness surfaces.
- Act 2 deepens it — the cult's true plan, the real scope.
- Act 3 is the final confrontation — avert the awakening, or face the end.

A Mystery is a MECHANISM, not a quest line. Progress is tracked by tokens
accumulating ON the Mystery card; investigators travel the whole map, gather
clues wherever the Mythos scattered them, and CONVERT those clues into progress.
NEVER make a Mystery "collect clues at locations A and B" — that kills the map.

Each Mystery:
- \`flavorText\` — one atmospheric line; \`text\` — the rules text, human-readable.
- \`onEnter\` — an Effect-DSL program run when the Mystery becomes active.
  Typically seeds the board: place eldritch tokens on random spaces, spawn a
  key monster, or \`placeMysteryToken\` on a key location.
- \`progressHook\` (optional) — how investigators advance it: \`{ trigger, effect }\`.
  \`trigger\` ∈ researchEncounterResolved | gateClosed | encounterAtMysteryToken |
  encounterAtEldritchToken | monsterDefeated | gainingArtifact. \`effect\` is a
  DSL program — usually a \`choice\` letting the investigator spend clues to
  place a token on this card (\`placeEldritchToken\` with where "self").
- \`solveCondition\` — checked each Mythos Phase: \`{ kind, n? }\`.
  kind ∈ tokensOnCard (needs n) | cluesOnCard (needs n) | monsterDefeated.
- \`resolution\` — the narrative of solving it + what it unlocks for the next act.

A Mystery with no \`progressHook\` is a "defeat X" Mystery — \`onEnter\` spawns the
monster, \`solveCondition\` is monsterDefeated.

### keyNPCs (2–6)
Recurring characters encounters can reuse. \`name\`, \`role\`, \`allegiance\`
(enemy / ally / ambiguous), \`description\`.

### keyLocations (2–6)
Plot-critical places. \`location\` MUST be an exact name from the map locations
listed in the user message. \`significance\` — its role in the story.

### escalation (exactly 3, one per act)
How the world degrades. Per act: \`tone\`, \`worldState\` (what is visibly,
tangibly wrong in the world now).

### mythosDeck — the Mythos cards (~4–6 per act, ~15 total)
The Mythos deck drives the doom clock and the dread. Cards are tiered by \`act\`
(I / II / III) — later acts heavier and grimmer. Each card has:
- \`name\`, \`flavorText\` (one atmospheric line shown when drawn), \`text\`
  (the card's rules text, human-readable).
- \`subtype\`: "event" (resolve, then discard) or "process" (stays by the
  Ancient One sheet, keeps acting until discarded).
- effect slots — ordered lists of Effect-DSL nodes (the SAME DSL as encounters):
  - \`onDraw\` — resolved when the card is drawn. EVERY card has this.
  - \`whileInPlay\` — ongoing effect; "process" cards only.
  - \`onReckoning\` — fires when a reckoning is resolved; "process" cards only.

An Effect node is an ACTION \`{ "do": <verb>, "target"?, ...params }\` or a
combinator (\`choice\`, \`group\`). Mythos effects hit the WHOLE table — set
\`target\`. Verbs for Mythos:
- \`advanceOmen\` \`{ direction: "cw"|"ccw", steps }\` — moves the omen token;
  doom then rises per open gates of the new omen. Most onDraw lists start here.
- \`advanceDoom\` \`{ amount }\` — push the doom clock directly.
- \`openGate\` \`{ count }\` — open gates; a monster crawls from each.
- \`spawnMonster\` \`{ count, where }\` — extra monsters (e.g. where: "gatesMatchingOmen").
- \`placeClue\` \`{ count }\` · \`placeEldritchToken\` \`{ count }\` · \`placeRumor\` \`{ location }\`
- \`resolveReckoning\` — trigger a reckoning across the table.
- investigator hits — \`loseHealth\` / \`loseSanity\` \`{ amount }\`,
  \`gainCondition\` \`{ condition }\` — always with \`target\`.
- \`text\` \`{ text }\` — a prose-only effect the engine just shows (fallback).
\`target\`: "lead" / "each" / "eachOnCity" / "eachOnWilderness" / "eachOnSea".
\`condition\` is an english id (cursed, blessed, madness, paranoia, debt, …).

Two compact examples (write your own):
- event, act 1:
  { "act": 1, "name": "…", "subtype": "event", "flavorText": "…", "text": "…",
    "onDraw": [ { "do": "advanceOmen", "direction": "cw", "steps": 1 },
                { "do": "openGate", "count": 1 } ] }
- process, act 2:
  { "act": 2, "name": "…", "subtype": "process", "flavorText": "…", "text": "…",
    "onDraw": [ { "do": "placeEldritchToken", "count": 2 } ],
    "whileInPlay": [ { "do": "text", "text": "Сыщики не могут отдыхать." } ],
    "onReckoning": [ { "do": "loseSanity", "target": "each", "amount": 1 } ] }

## Hard rules
- Output language: ${language}. Every name and text field must be in ${language}.
- keyLocations.location and placeRumor.location must be exact names from the
  provided map locations — do not invent map locations.
- Output as a single emit_campaign tool call.
- No real living people, no copyrighted IP characters.
`.trim();
}

// ── User prompt ────────────────────────────────────────────────────────────────

export function buildCampaignUserPrompt(input: CampaignPromptInput): string {
  const { locations, themeHint } = input;
  const language    = input.language?.trim() || DEFAULT_LANGUAGE;
  const playerCount = input.playerCount ?? DEFAULT_PLAYER_COUNT;
  const ancientOne  = input.ancientOne?.trim();

  const locList = locations.length
    ? locations.map((l) => `- ${l.name} (${l.type})`).join('\n')
    : '- (нет локаций)';

  return `
Design one complete campaign for the following game map.

## Map locations
Use these EXACT names for keyLocations and placeRumor:
${locList}

## Party
${playerCount} investigator(s) — scale doomClock and Mythos effect counts to this.

${ancientOne ? `## Ancient One (required)\nThe campaign MUST centre on this Ancient One: ${ancientOne}\n` : ''}
${themeHint ? `## Theme hint\n${themeHint}\n` : ''}
## Output
Call the \`emit_campaign\` tool. The campaign must:
- centre on a single Ancient One
- have exactly ${CAMPAIGN_MYSTERY_COUNT} mysteries (acts 1, 2, 3) — an escalating chain
- have exactly ${CAMPAIGN_MYSTERY_COUNT} escalation entries (acts 1, 2, 3)
- have a mythosDeck of roughly 4–6 cards per act
- ground keyLocations in the map locations above (exact names)
- be written entirely in ${language}
`.trim();
}

export function buildCampaignPrompt(input: CampaignPromptInput): { system: string; user: string } {
  const language = input.language?.trim() || DEFAULT_LANGUAGE;
  return {
    system: buildCampaignSystemPrompt(language),
    user:   buildCampaignUserPrompt(input),
  };
}

// ── Tool use schema ────────────────────────────────────────────────────────────
// id (кампании, мистерий, карт Мифов) проставляет сервер — модель его не даёт.

export const CAMPAIGN_TOOL: Anthropic.Tool = {
  name: 'emit_campaign',
  description: 'Emit one complete campaign scenario bible.',
  input_schema: {
    type: 'object',
    required: ['campaign'],
    properties: {
      campaign: {
        type: 'object',
        required: [
          'title', 'ancientOne', 'doomClock', 'theme', 'omenSymbols',
          'mysteries', 'keyNPCs', 'keyLocations', 'escalation', 'mythosDeck',
        ],
        properties: {
          title: { type: 'string' },
          ancientOne: {
            type: 'object',
            required: ['name', 'epithet', 'description', 'awakening'],
            properties: {
              name:        { type: 'string' },
              epithet:     { type: 'string' },
              description: { type: 'string' },
              awakening:   { type: 'string' },
            },
          },
          doomClock:   { type: 'integer', minimum: 6, maximum: 20 },
          theme:       { type: 'array', minItems: 2, maxItems: 6, items: { type: 'string' } },
          omenSymbols: { type: 'array', minItems: 3, maxItems: 4, items: { type: 'string' } },
          mysteries: {
            type: 'array', minItems: 3, maxItems: 3,
            items: {
              type: 'object',
              required: ['act', 'title', 'flavorText', 'text', 'onEnter', 'solveCondition', 'resolution'],
              properties: {
                act:        { type: 'integer', minimum: 1, maximum: 3 },
                title:      { type: 'string' },
                flavorText: { type: 'string' },
                text:       { type: 'string' },
                onEnter:    { type: 'array', items: { $ref: EFFECT_REF } },
                progressHook: {
                  type: 'object',
                  required: ['trigger', 'effect'],
                  properties: {
                    trigger: { type: 'string', enum: [...MYSTERY_TRIGGERS] },
                    effect:  { type: 'array', items: { $ref: EFFECT_REF } },
                  },
                },
                solveCondition: {
                  type: 'object',
                  required: ['kind'],
                  properties: {
                    kind: { type: 'string', enum: [...MYSTERY_SOLVE_KINDS] },
                    n:    { type: 'integer', minimum: 1 },
                  },
                },
                resolution: { type: 'string' },
              },
            },
          },
          keyNPCs: {
            type: 'array', minItems: 2, maxItems: 6,
            items: {
              type: 'object',
              required: ['name', 'role', 'allegiance', 'description'],
              properties: {
                name:        { type: 'string' },
                role:        { type: 'string' },
                allegiance:  { type: 'string', enum: ['enemy', 'ally', 'ambiguous'] },
                description: { type: 'string' },
              },
            },
          },
          keyLocations: {
            type: 'array', minItems: 2, maxItems: 6,
            items: {
              type: 'object',
              required: ['location', 'significance'],
              properties: {
                location:     { type: 'string' },
                significance: { type: 'string' },
              },
            },
          },
          escalation: {
            type: 'array', minItems: 3, maxItems: 3,
            items: {
              type: 'object',
              required: ['act', 'tone', 'worldState'],
              properties: {
                act:        { type: 'integer', minimum: 1, maximum: 3 },
                tone:       { type: 'string' },
                worldState: { type: 'string' },
              },
            },
          },
          mythosDeck: {
            type: 'array', minItems: 9, maxItems: 18,
            items: { $ref: '#/$defs/mythosCard' },
          },
        },
      },
    },
    $defs: {
      mythosCard: {
        type: 'object',
        required: ['act', 'name', 'subtype', 'flavorText', 'text', 'onDraw'],
        properties: {
          act:         { type: 'integer', minimum: 1, maximum: 3 },
          name:        { type: 'string' },
          subtype:     { type: 'string', enum: ['event', 'process'] },
          flavorText:  { type: 'string' },
          text:        { type: 'string' },
          // Слоты — программы Effect-DSL (узлы из $defs/Effect).
          onDraw:      { type: 'array', items: { $ref: EFFECT_REF } },
          whileInPlay: { type: 'array', items: { $ref: EFFECT_REF } },
          onReckoning: { type: 'array', items: { $ref: EFFECT_REF } },
        },
      },
      [EFFECT_DEF_NAME]: effectJsonDef(),
    },
  },
};
