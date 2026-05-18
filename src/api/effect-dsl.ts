import { z } from 'zod';

/**
 * Единый Effect-DSL — общий слой эффектов всего контента игры (встречи, Мифы,
 * состояния, активы, заклинания). См. EFFECT-DSL.md.
 *
 * Один источник истины — zod-схемы ниже. Из них:
 *   - TS-типы (z.infer);
 *   - JSON-Schema для tool-use и валидации (buildEffectJsonSchema()).
 *
 * Грамматики/парсера нет: DSL это JSON-AST, движок обходит дерево.
 */

// ── Enum'ы ──────────────────────────────────────────────────────────────────────

export const SKILLS = ['lore', 'influence', 'observation', 'strength', 'will'] as const;
export type Skill = typeof SKILLS[number];

/** Листовые действия. Точка расширения: добавил значение → добавил verb. */
export const ACTION_VERBS = [
  // по сыщику
  'loseHealth', 'healHealth', 'loseSanity', 'healSanity',
  'gainCondition', 'loseCondition',
  'gainClue', 'loseClue', 'spendClue',
  'gainAsset', 'loseAsset', 'gainSpell', 'loseSpell', 'gainArtifact',
  'improveSkill', 'impairSkill',
  'move', 'becomeDelayed', 'gainImprovement',
  // по полю / партии
  'advanceDoom', 'advanceOmen', 'moveOmen',
  'openGate', 'closeGate', 'discardGate',
  'spawnMonster', 'discardMonster',
  'placeClue', 'placeEldritchToken', 'placeRumor', 'placeMysteryToken', 'resolveReckoning',
  // по карте-носителю
  'flipCard', 'discardCard', 'drawMythos', 'drawCard',
  // fallback — движок показывает текстом, не исполняет
  'text',
] as const;
export type ActionVerb = typeof ACTION_VERBS[number];

export const TARGETS = [
  'lead', 'self', 'each',
  'eachOnCity', 'eachOnWilderness', 'eachOnSea', 'eachOnSpace',
  'eachWith', 'chosen',
  'eachMonster', 'eachGate', 'eachCondition', 'eachMythos',
] as const;
export type Target = typeof TARGETS[number];

export const PREDICATE_KINDS = [
  'always', 'hasCondition', 'hasAsset',
  'healthAtMost', 'sanityAtMost', 'isLead',
  'noGatesMatchingOmen', 'noMonstersOnBoard', 'noRumorsInPlay',
] as const;
export type PredicateKind = typeof PREDICATE_KINDS[number];

export const COUNT_SOURCES = [
  'gatesMatchingOmen', 'gatesOnBoard', 'monstersOnBoard',
  'cluesOnBoard', 'rumorsInPlay', 'conditionsOf', 'monsterToughness',
] as const;
export type CountSource = typeof COUNT_SOURCES[number];

/** Фиксированная библиотека id состояний (см. EFFECT-DSL.md §7). */
export const CONDITION_IDS = [
  'blessed', 'cursed', 'debt', 'darkPact', 'injury', 'madness', 'paranoia',
  'amnesia', 'detained', 'delayed', 'hypothermia', 'poisoned', 'hallucinations',
  'legInjury', 'internalInjury', 'backInjury', 'headInjury', 'haunted',
  'diseased', 'despair', 'righteous', 'lostInTimeAndSpace',
] as const;
export type ConditionId = typeof CONDITION_IDS[number];

export const ASSET_TRAITS = ['weapon', 'magical', 'item', 'tome', 'trinket', 'ally', 'service', 'relic'] as const;
export const SPELL_TRAITS = ['incantation', 'ritual', 'glamour'] as const;
export const OMEN_DIRECTIONS = ['cw', 'ccw'] as const;
export const CHOOSERS = ['self', 'lead', 'group'] as const;

/** Триггеры хука прогресса Мистерии (Mystery.progressHook.trigger). */
export const MYSTERY_TRIGGERS = [
  'researchEncounterResolved', 'gateClosed', 'encounterAtMysteryToken',
  'encounterAtEldritchToken', 'monsterDefeated', 'gainingArtifact',
] as const;
export type MysteryTrigger = typeof MYSTERY_TRIGGERS[number];

/** Виды условия раскрытия Мистерии (Mystery.solveCondition.kind). */
export const MYSTERY_SOLVE_KINDS = ['tokensOnCard', 'cluesOnCard', 'monsterDefeated'] as const;
export type MysterySolveKind = typeof MYSTERY_SOLVE_KINDS[number];

// ── Предикат / число ────────────────────────────────────────────────────────────

/** Предикат `when` — плоский (без рекурсии), отрицание через `not`. */
export const predicateSchema = z.object({
  kind:      z.enum(PREDICATE_KINDS),
  not:       z.boolean().optional(),         // отрицание предиката
  condition: z.enum(CONDITION_IDS).optional(),
  trait:     z.string().optional(),
  n:         z.number().int().optional(),    // для healthAtMost / sanityAtMost
});
export type Predicate = z.infer<typeof predicateSchema>;

/** `repeat` — литерал или источник числа («for each X»). */
export const countSchema = z.union([
  z.number().int().min(1),
  z.object({
    source:    z.enum(COUNT_SOURCES),
    condition: z.enum(CONDITION_IDS).optional(),   // для conditionsOf
  }),
]);
export type Count = z.infer<typeof countSchema>;

// ── Action — лист дерева ────────────────────────────────────────────────────────

/**
 * Один Action-объект для всех verb'ов. Параметры опциональны — релевантность
 * зависит от `do`. Так схема компактна, надёжна для LLM и тривиально
 * расширяема (новый verb = значение enum, без нового варианта схемы).
 */
export const actionSchema = z.object({
  do:        z.enum(ACTION_VERBS),
  target:    z.enum(TARGETS).optional(),
  when:      predicateSchema.optional(),
  repeat:    countSchema.optional(),
  // параметры verb'ов
  amount:    z.number().int().optional(),    // lose/heal Health/Sanity, advanceDoom, improve/impair
  count:     z.number().int().optional(),    // clue/gate/monster counts
  skill:     z.enum(SKILLS).optional(),      // improveSkill / impairSkill
  condition: z.enum(CONDITION_IDS).optional(),
  direction: z.enum(OMEN_DIRECTIONS).optional(),
  steps:     z.number().int().optional(),
  where:     z.string().optional(),          // куда: space / gate / self ...
  from:      z.string().optional(),          // gainAsset: deck|reserve|random
  trait:     z.string().optional(),          // фильтр актива/заклинания
  location:  z.string().optional(),          // placeRumor
  context:   z.string().optional(),          // напр. "combatEncounter" для пассивов
  text:      z.string().optional(),          // для do:"text"
});
export type Action = z.infer<typeof actionSchema>;

// ── Effect — рекурсивный узел ───────────────────────────────────────────────────

export type Effect =
  | Action
  | { choice: Effect[]; by?: typeof CHOOSERS[number] }
  | { test: Skill; modifier?: number; onPass: Effect[]; onFail: Effect[] }
  | { dieRoll: { on: string; then: Effect[] }[] }
  | { group: Effect[] };

export const effectSchema: z.ZodType<Effect> = z.lazy(() => z.union([
  actionSchema,
  z.object({
    choice: z.array(effectSchema).min(2),
    by:     z.enum(CHOOSERS).optional(),
  }),
  z.object({
    test:     z.enum(SKILLS),
    modifier: z.number().int().optional(),
    onPass:   z.array(effectSchema),
    onFail:   z.array(effectSchema),
  }),
  z.object({
    dieRoll: z.array(z.object({
      on:   z.string(),                      // диапазон: "1-2" / "6" / ...
      then: z.array(effectSchema),
    })).min(1),
  }),
  z.object({ group: z.array(effectSchema).min(1) }),
]));

/** Программа эффектов в одном слоте-триггере — упорядоченный список узлов. */
export const effectProgramSchema = z.array(effectSchema);
export type EffectProgram = Effect[];

// ── JSON-Schema (для tool-use Anthropic и валидации) ───────────────────────────

/** Имя $def и $ref Effect-узла при встраивании в tool-схему. */
export const EFFECT_DEF_NAME = 'Effect';
export const EFFECT_REF      = `#/$defs/${EFFECT_DEF_NAME}`;

/** Рекурсивно переписывает корневые $ref ("#") на заданную ссылку. */
function rewriteRootRefs(node: unknown, ref: string): unknown {
  if (Array.isArray(node)) return node.map((n) => rewriteRootRefs(n, ref));
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = (k === '$ref' && v === '#') ? ref : rewriteRootRefs(v, ref);
    }
    return out;
  }
  return node;
}

/**
 * JSON-Schema Effect-узла, готовая лечь в `$defs` любой tool-схемы.
 * zod выдаёт рекурсию как `$ref: "#"` — нормализуем на `#/$defs/Effect`,
 * мета-поля ($schema/$id) убираем.
 */
export function effectJsonDef(): Record<string, unknown> {
  const raw   = z.toJSONSchema(effectSchema, { target: 'draft-2020-12' });
  const fixed = rewriteRootRefs(raw, EFFECT_REF) as Record<string, unknown>;
  delete fixed['$schema'];
  delete fixed['id'];
  delete fixed['$id'];
  return fixed;
}
