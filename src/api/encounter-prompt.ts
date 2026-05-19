import type Anthropic from '@anthropic-ai/sdk';
import { EFFECT_REF, EFFECT_DEF_NAME, effectJsonDef } from './effect-dsl.js';

/**
 * Промпт для генерации карточек встреч в лавкрафтианской игре про сыщиков.
 *
 * buildEncounterPrompt({...}) → { system, user } для вызова LLM.
 * ENCOUNTER_TOOL — JSON-схема tool use: модель обязана вернуть валидный JSON.
 */

// ── Доменные значения (единый источник для типов и zod/JSON-схем) ──────────────

export const SKILL_NAMES = ['lore', 'influence', 'observation', 'strength', 'will'] as const;
export type SkillName = typeof SKILL_NAMES[number];

export const TAGS = ['weapon', 'trinket', 'item', 'magical', 'relic', 'ally', 'service', 'teamwork'] as const;
export type Tag = typeof TAGS[number];

export const LOCATION_TYPES = ['city', 'wilderness', 'sea'] as const;
export type LocationType = typeof LOCATION_TYPES[number];

export const CONDITIONS = [
  'Долг', 'Заключение', 'Травма ноги', 'Травма спины', 'Проклятие',
  'Паранойя', 'Галлюцинации', 'Безумие', 'Благословение',
] as const;
export type Condition = typeof CONDITIONS[number];

/** Виды встреч. general — обычная; research — по Мистерии; gate — Иной мир. */
export const ENCOUNTER_KINDS = ['general', 'research', 'gate'] as const;
export type EncounterKind = typeof ENCOUNTER_KINDS[number];

/** Иные миры за вратами — фиксированный набор (для kind: "gate"). */
export const OTHER_WORLDS = [
  'Dreamlands', 'Yuggoth', 'The Abyss', 'The Underworld',
  'City of the Great Race', 'Lost Carcosa', 'Great Hall of Celaeno',
  'The Past', 'The Future',
] as const;
export type OtherWorld = typeof OTHER_WORLDS[number];

// ── Вход билдера промпта ───────────────────────────────────────────────────────

/**
 * Компактный срез сценарной библии — встреча генерится как бит этой истории.
 * Извлекается из сохранённой кампании в encounters.ts по campaignId + act.
 */
export interface CampaignContext {
  ancientOne: { name: string; epithet: string; description?: string };
  theme:      string[];
  doomClock:  number;
  /** Текущий уровень doom (если известен). */
  doom?:      number;
  /** Текущий акт (1/2/3). */
  act:        number;
  /** Мистерия текущего акта. */
  mystery:    { title: string; text: string };
  /** Эскалация текущего акта. */
  escalation: { tone: string; worldState: string };
  /** Ключевые NPC и локации — встреча может их переиспользовать. */
  keyNPCs?:      { name: string; role: string; allegiance: string }[];
  keyLocations?: { location: string; significance: string }[];
}

export interface EncounterPromptInput {
  /** Вид встречи. По умолчанию general. */
  kind?: EncounterKind;
  /** Персона сыщика — имя и бэкграунд. */
  investigator: {
    name: string;
    background: string;
  };
  /** Реальная локация — для general / research. */
  realLocation?: {
    name: string;
    locationType: LocationType;
    flavor?: string;
  };
  /** Иной мир за вратами — для kind: "gate". */
  otherWorld?: OtherWorld;
  /** Активные состояния на сыщике (чтобы не выдать дубликат + для флейвора). */
  conditions: Condition[];
  /** Сколько карточек сгенерировать за вызов. */
  count?: number;
  /** Опциональная подсказка-тема — «ночь», «после дождя» и т.п. */
  themeHint?: string;
  /** Язык текста карточек (название языка, напр. "Russian", "English"). */
  language?: string;
  /** Контекст кампании. Пусто → встреча самодостаточна (как раньше). */
  campaign?: CampaignContext;
}

/** Язык по умолчанию, если в запросе не передан. */
export const DEFAULT_LANGUAGE = 'Russian';

// ── System prompt — стабилен между вызовами при одном языке ───────────────────

export function buildEncounterSystemPrompt(language: string): string {
  return `
You are a writer-designer for a Lovecraftian pulp-horror investigator board game
in the spirit of Arkham Horror / Eldritch Horror. Your job is to generate
*encounter cards* — short narrative vignettes the player resolves with a skill
check. You write in ${language}. You output JSON only, matching the schema given
in the user message via the provided tool.

## Tone & setting
- 1920s–1930s, weird tales, cosmic horror, occult, prohibition-era pulp.
- Concise, evocative, dry. No melodrama, no exclamation marks, no second-person
  cheerleading. Closer to Lovecraft / Hodgson / Blackwood than to YA fantasy.
- Match the register of classic weird-fiction translations into ${language}:
  slightly archaic, precise, restrained. Where the language marks formality,
  use the polite/formal "you" (in Russian — "вы", not "ты").

## Encounter kinds
The user message states the encounter \`kind\` — write to it:
- \`general\` — an ordinary encounter at a real-world location (city /
  wilderness / sea). Self-contained; the bread-and-butter card.
- \`research\` — an encounter at a location where a clue waits, tied to the
  campaign's current Mystery. On success it yields a clue or a lead the
  investigators can turn into Mystery progress; it carries the Ancient One's
  dread.
- \`gate\` — an OTHER WORLD encounter, and it is TWO-STAGE. The investigator
  has stepped through a Gate into an alien realm (\`otherWorld\`). The scene is
  NOT on Earth — it is that realm. Tone is the heaviest — alien geometry,
  cosmic indifference, deep time; sanity is the usual coin of failure. Gate
  cards have their own shape — see "## Other World (gate) cards are two-stage".

For \`kind: gate\`, \`otherWorld\` is one of these fixed realms — set the scene
there and let its character bleed through:
- Dreamlands — a vast realm of dream, myth and soft menace.
- Yuggoth — the black trans-Plutonian world of the fungal Mi-Go.
- The Abyss — a lightless, bottomless descent.
- The Underworld — caverns and corpse-lit cities beneath the earth.
- City of the Great Race — alien archives strewn across deep time.
- Lost Carcosa — the decadent dead city under twin suns and the Yellow Sign.
- Great Hall of Celaeno — a library of knowledge stolen from dead stars.
- The Past / The Future — a moment torn loose in time.

## Other World (gate) cards are two-stage
A \`gate\` card does NOT use the flat mainText/successText/failureText/test
fields. It has a \`stages\` array of EXACTLY TWO stage objects; each stage has
the same anatomy (mainText, successText, failureText, test, onSuccess,
onFailure) as a normal card.

- Stage 1 — arrival and ordeal. The investigator must endure / navigate /
  survive the alien realm. On success they press on and Stage 2 follows —
  Stage 1 \`onSuccess\` is usually empty or a small effect; do NOT close the
  gate here. On failure the encounter ENDS at Stage 1: apply \`onFailure\`,
  and the gate stays open.
- Stage 2 — the way back. The investigator works the rite or finds the path
  to seal the Gate. Stage 2 \`onSuccess\` MUST include { "do": "closeGate" }
  together with the run's payoff (a clue, an artifact, a heal). On failure:
  a cost, and the gate stays open.

The two stages must be a real progression — different skills, or a rising
stake — not the same test twice. \`general\` and \`research\` cards are
single-stage and never use \`stages\`.

## Card anatomy
Each card has three text fields plus mechanical effects:

1. \`mainText\` — 2–4 sentences. Sets the scene and ends by describing the
   action the investigator attempts. The skill check is referenced inline in
   parentheses with the skill icon implied by \`test.skill\`. Example endings:
   "Вы пытаетесь расшифровать их (lore)." or "Боретесь с нарастающим страхом
   (will)." Do NOT spell out the skill name as a word inside mainText — the
   engine renders the icon from \`test.skill\`.
2. \`successText\` — 1–2 sentences. What happens on success. Should feel
   earned but not safe — partial victories, ambiguous gains, eerie aftertaste.
3. \`failureText\` — 1–2 sentences. What happens on failure. Costly but not
   game-over. Often a condition, lost sanity, or a forced move.

For \`general\` / \`research\` these three fields and \`test\` sit flat on the
card. For \`gate\` they live inside each of the two \`stages\` instead.

## Skill checks
\`test.skill\` is one of: lore, influence, observation, strength, will.
- lore — books, ciphers, occult, ritual, ancient languages.
- influence — bribery, persuasion, social pressure, fast talk.
- observation — searching, tracking, spotting hidden things, navigation.
- strength — fights, breaking through, physical feats, swimming.
- will — fear, temptation, willpower vs the unnatural.

Pick the skill that *naturally* fits the action you described in \`mainText\`.
\`test.modifier\` stays in {0, -1, -2} — how it is chosen is in "## Difficulty".

## Effects — the Effect-DSL
\`onSuccess\` and \`onFailure\` are ordered lists of Effect nodes — what the
engine applies on that outcome. A node is an ACTION or a combinator.

ACTION — \`{ "do": <verb>, ...params }\`. Effects target the investigator
having this encounter; omit \`target\`. Verbs for encounters:
- \`gainClue\` / \`loseClue\` — \`{ count }\`
- \`loseHealth\` / \`healHealth\` / \`loseSanity\` / \`healSanity\` — \`{ amount }\`
- \`gainCondition\` / \`loseCondition\` — \`{ condition: <id> }\`
- \`gainAsset\` — \`{ from: "deck"|"reserve"|"random", trait? }\`
- \`gainSpell\` · \`gainArtifact\` · \`gainImprovement\`
- \`improveSkill\` — \`{ skill, amount }\`
- \`move\` — \`{ to: "adjacent" }\`
- \`text\` — \`{ text }\`: a prose-only effect the engine just shows (fallback
  for anything the verbs cannot express)

COMBINATOR — use only when needed:
- \`{ "choice": [EffectA, EffectB] }\` — the player picks ONE. Use this, and
  only this, for an "X ИЛИ Y" choice in the text.
- \`{ "group": [Effect, ...] }\` — a sub-list, mainly inside a choice branch.

Condition ids (for gainCondition / loseCondition):
blessed, cursed, debt, darkPact, injury, madness, paranoia, amnesia, detained,
delayed, hypothermia, poisoned, hallucinations, legInjury, internalInjury,
backInjury, headInjury, haunted, diseased, despair, righteous,
lostInTimeAndSpace.

Patterns:
- Success grants one–two of: clue, asset, spell, artifact, a 1–2 heal, a rare
  improveSkill. Failure inflicts one–two of: loseHealth/Sanity (1–2), a
  condition, a forced move — or nothing if the narrative alone stings.
- The JSON must match the prose: several effects listed → all apply; an "ИЛИ"
  in the text → a \`choice\` node. \`onSuccess\`/\`onFailure\` may be empty \`[]\`.

## Difficulty
The check difficulty (\`test.modifier\`) is driven by the VALUE of the reward
and the NARRATIVE of the task — NOT by the investigator's skills (you are not
given them, and must not assume them):
- Bigger / rarer reward → harder check. A spell, an artifact, an improveSkill,
  or two effects stacked together → modifier -1, occasionally -2. A single
  clue, a small heal, or one random asset → modifier 0.
- The narrative must match the modifier: an obviously hard or perilous task
  (deciphering eldritch script, forcing a sealed vault, facing a deep one) →
  -1 or -2; a simple task (a quick search, chatting up a barkeep) → 0.
- Failure cost scales with the check: a -2 card may cost 2 health/sanity or a
  condition; a 0 card costs little or nothing.
- Positive modifiers are rare — only a trivial task with a trivial reward.

## Conditions & flavor
You receive the investigator's active conditions. They do NOT change difficulty
— the card is self-contained content. Use them only to:
- NOT inflict a condition the investigator already has — pick a different
  effect, or none.
- Optionally reference an existing condition for flavor ("ваша больная нога
  ноет") — lightly, and not on every card.
- Mention the investigator's background once in a while when it adds flavor,
  not every card.

## Location fit
The real-world location is mapped to one of city / wilderness / sea by the
caller. Use specific details from \`realLocation.name\` and
\`realLocation.flavor\` to ground the card — street names, local trades,
weather, smells. Do not turn every card into a generic Arkham scene.

- city: police, mob, smugglers, antique shops, séances, tenements, docks,
  newspapermen, university libraries, asylums.
- wilderness: graves, ruins, megaliths, hermits, cults, fog, sick travelers,
  feral things, abandoned chapels, caves, swamps.
- sea: superstitious sailors, ghost ships, deep ones, storms, becalming,
  islands, salvage diving, mutiny, strange songs.

## Campaign context
You MAY receive a campaign context — the Ancient One, the current Mystery and
the act's escalation. When it is present, the encounter is a BEAT in that
larger story, not a standalone vignette:
- It must plausibly serve the current Mystery — usually by yielding clues or
  leads toward its \`objective\` on success. Don't resolve the Mystery in one
  card; advance it.
- It must carry the dread of the Ancient One and the tone/worldState of the
  current act — later acts darker, the wrongness more overt.
- You may reuse a key NPC or key location when it fits, for continuity.
- The encounter still happens at \`realLocation\` and is grounded there.
When NO campaign context is given, the encounter is fully self-contained.

## Hard rules
- Output language: ${language}. The \`name\` and every text field — flat
  mainText/successText/failureText, or those inside each \`stages\` entry —
  must be written in ${language}.
- In effects, \`condition\` is an english id from the list above; the card
  PROSE uses the localized condition name — the engine maps id ↔ name.
- Output format: a single tool call returning {"encounters": Encounter[]}.
- Do not invent verbs, conditions, or fields outside the Effect-DSL.
- Do not reuse the example cards verbatim — only their *style*.
- No real living people, no copyrighted IP characters.
- No graphic violence, no sexual content. Cosmic dread, not gore.

## Few-shot — style reference
The examples below are written in Russian to show *structure and style only* —
write your own cards entirely in ${language}.

Example 1 (general, city, lore -1 — plain action list):
{
  "name": "Букинист",
  "mainText": "Вы бродите по старинному букинистическому магазину. Здесь попадаются очень редкие книги, но разобраться, по какому принципу они расставлены на полках, почти невозможно (lore -1).",
  "successText": "Вы находите настоящее сокровище: возьмите 1 артефакт-книгу.",
  "failureText": "Хозяин косится на вас и просит уйти. Никаких последствий, кроме потерянного вечера.",
  "type": "encounter",
  "kind": "general",
  "locationType": "city",
  "test": { "skill": "lore", "modifier": -1 },
  "onSuccess": [ { "do": "gainArtifact" } ],
  "onFailure": []
}

Example 2 (general, wilderness, will -1 — two effects, a condition):
{
  "name": "Древние письмена",
  "mainText": "Освободив алтарь от многолетних наслоений мха и лишайника, вы видите вырезанные на камне первобытные письмена. Вы пытаетесь расшифровать их, борясь с нарастающим страхом (will -1).",
  "successText": "Получите 1 улику и возьмите 1 заклинание.",
  "failureText": "В панике бежите прочь: возьмите состояние «Проклятие».",
  "type": "encounter",
  "kind": "general",
  "locationType": "wilderness",
  "test": { "skill": "will", "modifier": -1 },
  "onSuccess": [ { "do": "gainClue", "count": 1 }, { "do": "gainSpell" } ],
  "onFailure": [ { "do": "gainCondition", "condition": "cursed" } ]
}

Example 3 (general, sea, observation 0 — a choice):
{
  "name": "Костёр на острове",
  "mainText": "На крошечном островке горит костёр, но людей не видно. Вы обыскиваете остров (observation).",
  "successText": "За камнями прячется беглец. Возьмите у него либо смятую карту с пометками (1 улика), либо его молчаливого охранника-союзника.",
  "failureText": "Загадка остаётся нераскрытой: возьмите состояние «Паранойя».",
  "type": "encounter",
  "kind": "general",
  "locationType": "sea",
  "test": { "skill": "observation", "modifier": 0 },
  "onSuccess": [
    { "choice": [
        { "do": "gainClue", "count": 1 },
        { "do": "gainAsset", "from": "reserve", "trait": "ally" } ] } ],
  "onFailure": [ { "do": "gainCondition", "condition": "paranoia" } ]
}

Example 4 (gate — Other World, TWO-STAGE: uses \`stages\`, not flat fields):
{
  "name": "Колодец без дна",
  "type": "encounter",
  "kind": "gate",
  "otherWorld": "The Abyss",
  "stages": [
    {
      "mainText": "Врата выводят не на земную твердь, а на узкий карниз над лишённым дна колодцем Бездны. Камень крошится под ногой; снизу поднимается дыхание, которое не воздух. Вы прижимаетесь к стене, чтобы не сорваться вниз (strength -1).",
      "successText": "Пальцы находят опору. Вы переводите дух — карниз ведёт дальше, к самой кромке портала.",
      "failureText": "Камень уходит из-под ног. Потеряйте 2 здоровья; Врата остаются открытыми за вашей спиной.",
      "test": { "skill": "strength", "modifier": -1 },
      "onSuccess": [],
      "onFailure": [ { "do": "loseHealth", "amount": 2 } ]
    },
    {
      "mainText": "У самого зева колодца воздух дрожит знаками. Вы пытаетесь начертить замыкающий знак, пока тьма внизу вас не заметила (lore -1).",
      "successText": "Знак вспыхивает и гаснет; зев колодца смыкается. Возьмите 1 улику. Врата закрыты.",
      "failureText": "Бездна выдыхает вам в лицо. Возьмите состояние «Безумие»; Врата остаются открытыми.",
      "test": { "skill": "lore", "modifier": -1 },
      "onSuccess": [ { "do": "gainClue", "count": 1 }, { "do": "closeGate" } ],
      "onFailure": [ { "do": "gainCondition", "condition": "madness" } ]
    }
  ]
}
`.trim();
}

// ── User prompt — per-request, живое состояние игрока ─────────────────────────

export function buildEncounterUserPrompt(input: EncounterPromptInput): string {
  const { investigator, realLocation, otherWorld, conditions, count = 1, themeHint, campaign } = input;
  const language = input.language?.trim() || DEFAULT_LANGUAGE;
  const kind = input.kind ?? 'general';

  // Блок места + правила: Иной мир (gate) либо реальная локация (general/research).
  let placeBlock: string;
  let placeRules: string;
  if (kind === 'gate') {
    const realm = otherWorld ?? '(choose a fitting Other World)';
    placeBlock = `## Other World — the encounter is set HERE, beyond the gate\n- Realm: ${realm}`;
    placeRules =
      `- be set inside the Other World "${realm}", not on Earth\n` +
      `- be TWO-STAGE: fill the "stages" array with EXACTLY 2 stages; do NOT\n` +
      `  use the flat mainText/successText/failureText/test fields\n` +
      `- Stage 2 onSuccess must seal the gate — include { "do": "closeGate" }`;
  } else {
    const name = realLocation?.name ?? '?';
    const lt   = realLocation?.locationType ?? 'city';
    placeBlock = `## Real-world location\n- Name: ${name}\n- Type: ${lt}` +
      (realLocation?.flavor ? `\n- Flavor notes: ${realLocation.flavor}` : '');
    placeRules =
      `- have \`locationType\` = "${lt}"\n` +
      `- ground itself in details of "${name}"`;
  }

  let campaignBlock = '';
  let campaignRule  = '';
  if (campaign) {
    const ao   = campaign.ancientOne;
    const npcs = (campaign.keyNPCs ?? [])
      .map((n) => `${n.name} (${n.role}, ${n.allegiance})`).join('; ');
    const locs = (campaign.keyLocations ?? []).map((l) => l.location).join(', ');
    campaignBlock = `
## Campaign context — this encounter is a beat in an ongoing story
- Ancient One: ${ao.name} — ${ao.epithet}
- Theme: ${campaign.theme.join(', ')}
- Act ${campaign.act}. Doom: ${campaign.doom ?? '?'} / ${campaign.doomClock}.
- Current Mystery: «${campaign.mystery.title}» — ${campaign.mystery.text}
- The world right now (${campaign.escalation.tone}): ${campaign.escalation.worldState}
${npcs ? `- Key NPCs you may reuse: ${npcs}\n` : ''}${locs ? `- Key locations: ${locs}\n` : ''}`;
    campaignRule = '\n- advance the current Mystery (yield clues/leads it can use) and carry the Ancient One\'s dread';
  }

  return `
Generate ${count} encounter card(s) — kind: ${kind}.

## Investigator
- Name: ${investigator.name}
- Background: ${investigator.background}

${placeBlock}

## Active conditions
${conditions.length ? conditions.map((c) => `- ${c}`).join('\n') : '- (none)'}
${campaignBlock}
${themeHint ? `## Theme hint\n${themeHint}\n` : ''}
## Output
Call the \`emit_encounters\` tool with a JSON object:
{ "encounters": Encounter[] }
Each encounter must:
- have \`kind\` = "${kind}"
- be written entirely in ${language}
${placeRules}
- pick a skill check that fits the action described in mainText
- set test.modifier from reward value + narrative (see "## Difficulty")
- not duplicate any active condition the investigator already has${campaignRule}
`.trim();
}

export function buildEncounterPrompt(input: EncounterPromptInput): { system: string; user: string } {
  const language = input.language?.trim() || DEFAULT_LANGUAGE;
  return {
    system: buildEncounterSystemPrompt(language),
    user:   buildEncounterUserPrompt(input),
  };
}

// ── Tool use schema — модель обязана вернуть валидный JSON ─────────────────────
// `id` модель НЕ генерирует: сервер проставляет uuid сам (см. encounters.ts).

// Схема проверки навыка — переиспользуется на верхнем уровне (general/research)
// и внутри каждой стадии двухступенчатой gate-встречи.
const TEST_SCHEMA = {
  type: 'object',
  required: ['skill', 'modifier'],
  properties: {
    skill:    { type: 'string', enum: [...SKILL_NAMES] },
    modifier: { type: 'integer', minimum: -3, maximum: 2 },
  },
};

export const ENCOUNTER_TOOL: Anthropic.Tool = {
  name: 'emit_encounters',
  description: 'Emit one or more encounter cards.',
  input_schema: {
    type: 'object',
    required: ['encounters'],
    properties: {
      encounters: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          // general/research заполняют плоские mainText/.../test; gate
          // заполняет stages[2]. Конкретную форму по kind задаёт промпт.
          required: ['name', 'type', 'kind'],
          properties: {
            name:         { type: 'string' },
            type:         { type: 'string', enum: ['encounter'] },
            kind:         { type: 'string', enum: [...ENCOUNTER_KINDS] },
            tags:         { type: 'array', items: { type: 'string', enum: [...TAGS] } },
            // locationType — для general/research; otherWorld — для gate.
            locationType: { type: 'string', enum: [...LOCATION_TYPES] },
            otherWorld:   { type: 'string', enum: [...OTHER_WORLDS] },
            // Одноступенчатая встреча (general/research) — плоские поля.
            mainText:     { type: 'string' },
            successText:  { type: 'string' },
            failureText:  { type: 'string' },
            test:         TEST_SCHEMA,
            onSuccess:    { type: 'array', items: { $ref: EFFECT_REF } },
            onFailure:    { type: 'array', items: { $ref: EFFECT_REF } },
            // Двухступенчатая встреча (gate / Иной мир) — ровно 2 стадии.
            stages: {
              type: 'array',
              minItems: 2,
              maxItems: 2,
              items: { $ref: '#/$defs/EncounterStage' },
            },
          },
        },
      },
    },
    $defs: {
      [EFFECT_DEF_NAME]: effectJsonDef(),
      // Одна стадия gate-встречи — та же анатомия, что у плоской карты.
      EncounterStage: {
        type: 'object',
        required: ['mainText', 'successText', 'failureText', 'test'],
        properties: {
          mainText:    { type: 'string' },
          successText: { type: 'string' },
          failureText: { type: 'string' },
          test:        TEST_SCHEMA,
          onSuccess:   { type: 'array', items: { $ref: EFFECT_REF } },
          onFailure:   { type: 'array', items: { $ref: EFFECT_REF } },
        },
      },
    },
  },
};
