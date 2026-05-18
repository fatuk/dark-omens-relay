# Dark Omens — единый Effect-DSL (дизайн-документ)

## Зачем

Весь контент игры — встречи, Мифы, состояния, предметы, заклинания, монстры —
«что-то делает». Сейчас эффекты встреч и Мифов — два разных ad-hoc списка, а
состояния вообще просто строки-ярлыки.

Документ описывает **один слой эффектов** для всего:

- одна грамматика, по которой LLM генерит любой контент;
- один интерпретатор, который движок (Godot) реализует **один раз**;
- состояния / предметы / заклинания становятся полноценным контентом со своими
  эффектами и последствиями.

Основан на разборе полного набора карт Eldritch Horror (37 листов).

Подход — вариант **C** из обсуждения: JSON-AST с **ограниченной** вложенностью.
Не плоский список (не выразит условия), но и не безграничная рекурсия (LLM
надёжнее, движку — конечный интерпретатор).

---

## 1. Модель контента: носители и слоты-триггеры

Каждый «носитель эффектов» имеет именованные **слоты** — момент, когда эффекты
срабатывают. В слоте лежит **программа** — упорядоченный список Effect-узлов.

| Носитель | Слоты |
|---|---|
| Встреча | `test` (проверка навыка) → `onSuccess` / `onFailure`; без проверки — `onResolve` |
| Миф · Event | `onDraw` |
| Миф · Ongoing (процесс) | `onEnter`, `whileInPlay`, `onReckoning` |
| Миф · Rumor (слух) | `onEnter`, `onReckoning`, `onSolve`, `encounterAt` (привязка к локации) |
| Состояние | `whileHeld`, `onGain`, `onReckoning`; двустороннее → `back` (вскрытая сторона со своими слотами) |
| Актив (предмет) | `whileOwned` (пассив), `action` (активируемая способность), `onReckoning` |
| Заклинание | `whileOwned` / `action` (лицо), `onCast` (исход — оборот карты) |
| Монстр | `whileOnBoard`, `onReckoning` + combat-статы |

Грамматика Effect-узла **одна и та же** во всех слотах. Новый тип контента =
новый носитель с теми же слотами.

---

## 2. Грамматика Effect-узла

```
Effect :=
  | Action                                    // одно игровое действие
  | { "choice":  Effect[], "by"?: Chooser }   // игрок выбирает ОДНУ ветку
  | { "test":    Skill, "modifier"?: int,
      "onPass":  Effect[], "onFail": Effect[] }
  | { "dieRoll": [ { "on": Range, "then": Effect[] }, ... ] }
  | { "group":   Effect[] }                   // под-список (для веток choice)
```

`Action` — лист дерева:

```
Action := {
  "do":      ActionVerb,
  "target"?: Target,        // по умолчанию — контекстный (носитель / Lead)
  "when"?:   Predicate,     // действие исполняется, только если истинно
  "repeat"?: Count,         // исполнить N раз / «for each X»
  ...verb-specific params
}
```

`when` и `repeat` — **не рекурсивные**: предикаты и источники чисел берутся из
ограниченных enum'ов (раздел 4). Вложенность дают только `choice` / `test` /
`dieRoll`, и она неглубокая — реальные карты не глубже 2 уровней.

---

## 3. ActionVerb — словарь листовых действий

**По сыщику:**
`loseHealth` · `healHealth` · `loseSanity` · `healSanity` `{amount}`
`gainCondition` · `loseCondition` `{condition}`
`gainClue` · `loseClue` · `spendClue` `{count}`
`gainAsset` `{from: deck|reserve|random, trait?}` · `loseAsset` `{trait?}`
`gainSpell` · `loseSpell` · `gainArtifact`
`improveSkill` · `impairSkill` `{skill, amount}`
`move` `{to: adjacent|nearestGate|space}` · `becomeDelayed` · `gainImprovement`

**По полю / партии:**
`advanceDoom` `{amount}`
`advanceOmen` `{direction: cw|ccw, steps}` · `moveOmen` `{to: chosen}`
`openGate` `{count}` · `closeGate` · `discardGate` `{match: omen|any}`
`spawnMonster` `{count, where}` · `discardMonster`
`placeClue` `{count, where}` · `placeEldritchToken` `{count, on: self}`
`placeRumor` `{location}` · `resolveReckoning`

**По карте-носителю:**
`flipCard` (двусторонние) · `discardCard` · `drawMythos` · `drawCard` `{deck}`

**Fallback:**
`text` `{text}` — эффект, который движок **показывает**, но не исполняет
(см. раздел 6). Длинный хвост карт.

---

## 4. Модификаторы: target / when / repeat

### Target
`lead` · `self` (носитель) · `each` (каждый сыщик)
`eachOnCity` · `eachOnWilderness` · `eachOnSea` · `eachOnSpace`
`eachWith` `{condition? | assetTrait?}` · `chosen` (игрок выбирает)
`eachMonster` · `eachGate` · `eachCondition` · `eachMythos` (для resolveReckoning-стиля)

### Predicate (`when`) — ограниченные проверки состояния
`always` (по умолчанию) · `hasCondition {condition}` · `hasAsset {trait?}`
`healthAtMost {n}` · `sanityAtMost {n}` · `isLead`
`noGatesMatchingOmen` · `noMonstersOnBoard` · `noRumorsInPlay`
обёртки: `not` · `allOf` / `anyOf` (макс. 2–3 — без глубокой вложенности)

### Count (`repeat`) — литерал или источник числа
литерал `int` · `gatesMatchingOmen` · `gatesOnBoard` · `monstersOnBoard`
`cluesOnBoard` · `rumorsInPlay` · `conditionsOf {condition}` · `monsterToughness`

### Combinators
- `choice` — «may do one of: …». `by` = кто выбирает (`self`/`lead`/`group`).
- `test` — проверка навыка → `onPass` / `onFail`. У встреч это корневой узел;
  у активов/заклинаний — внутри `action`.
- `dieRoll` — бросок → ветки по диапазонам (`"1-2"`, `"3-5"`, `"6"`).

«X unless Y», где Y — выбор игрока, выражается через `choice`:
`{choice: [<X>, <Y-эффект>]}`. «X unless <группа тратит улики>» — через `test`/`when`.

---

## 5. Скилы, состояния, трейты — enum'ы

- **Skill:** `lore` · `influence` · `observation` · `strength` · `will`
- **Condition:** библиотека (раздел 7) — `blessed`, `cursed`, `debt`, `darkPact`,
  `injury`, `madness`, `paranoia`, `amnesia`, `detained`, `delayed`,
  `hypothermia`, `poisoned`, `hallucinations`, … (id-шники; набор фиксирован).
- **AssetTrait:** `weapon` · `magical` · `item` · `tome` · `trinket` · `ally`
  · `service` · `relic`
- **SpellTrait:** `incantation` · `ritual` · `glamour`
- **LocationType:** `city` · `wilderness` · `sea`

---

## 6. Принцип двух слоёв

Каждый носитель **всегда** имеет:

1. `text` — человекочитаемый текст карты (показ игроку + источник истины);
2. структурированные слоты эффектов — **исполняемая проекция** для движка.

LLM генерит оба. Что движок ещё не умеет исполнить — он показывает текстом
(`{do: "text"}`). Карта остаётся полной и играбельной даже при неполном
покрытии DSL. Так устроен и сам Eldritch Horror — карта это текст, иконки лишь
подсказки. Это снимает риск «бесконечного DSL»: структурируем частотное,
остальное живёт текстом и доструктурируется по мере реализации в Godot.

---

## 7. Состояния как контент

Сейчас `addCondition: "Проклятие"` вешает голый ярлык. В новой модели состояние —
объект из фиксированной библиотеки:

```jsonc
{
  "id": "cursed",
  "name": "Проклятие",
  "kind": "curse",                 // curse|bless|injury|madness|disease|restriction|debt|...
  "text": "...",
  "whileHeld":   [ /* пассивные модификаторы */ ],
  "onReckoning": [ /* что срабатывает в расплату */ ],
  "back": { "name": "...", "text": "...", "onReckoning": [...] }   // вскрытая сторона
}
```

Эффекты встреч/Мифов ссылаются на состояние по `id`. Расплата (`resolveReckoning`)
= движок проходит все компоненты и исполняет их `onReckoning` — за один момент.
Реальные «Disc/Madness/Injury»-карты двусторонние: `onReckoning` часто = бросок,
по плохому исходу — `flipCard` на сторону `back`.

---

## 8. Карты на DSL — примеры

**Миф «Heat Wave Singes the Globe»** (каждый теряет 3 HP, если не станет Delayed):
```json
{ "onDraw": [
  { "target": "each", "choice": [
      { "do": "loseHealth", "amount": 3 },
      { "do": "becomeDelayed" } ] } ] }
```

**Миф «Perplexing Stars»** (омен ccw на 1, затем +doom за каждые врата знамения):
```json
{ "onDraw": [
  { "do": "advanceOmen", "direction": "ccw", "steps": 1 },
  { "do": "advanceDoom", "amount": 1, "repeat": "gatesMatchingOmen" } ] }
```

**Миф «Tide of Despair»** (каждый теряет 2/2, если не сбросит Благословение):
```json
{ "onDraw": [
  { "target": "each", "choice": [
      { "group": [ { "do": "loseHealth", "amount": 2 },
                   { "do": "loseSanity", "amount": 2 } ] },
      { "do": "loseCondition", "condition": "blessed" } ] } ] }
```

**Встреча** (проверка lore −1; успех — улики, провал — состояние):
```json
{ "test": "lore", "modifier": -1,
  "onSuccess": [ { "do": "placeClue", "count": 2, "where": "self" } ],
  "onFailure": [ { "do": "gainCondition", "condition": "cursed" } ] }
```

**Состояние «Cursed»** (расплата: бросок, на 1–3 — вскрытие):
```json
{ "onReckoning": [
  { "dieRoll": [
      { "on": "1-3", "then": [ { "do": "flipCard" } ] },
      { "on": "4-6", "then": [] } ] } ] }
```

**Актив «Axe»** (+1 strength в боевых встречах) — пассив с контекстом:
```json
{ "whileOwned": [
  { "do": "improveSkill", "skill": "strength", "amount": 1,
    "context": "combatEncounter" } ] }
```

**Заклинание «Mind's Eye» (Glamour)** — пассив + расплата с проверкой:
```json
{ "whileOwned": [ { "do": "text", "text": "Переброс 1 кубика в проверке lore/observation." } ],
  "onReckoning": [
    { "test": "will",
      "onPass": [ { "do": "flipCard" } ],
      "onFail": [ { "do": "loseSanity", "amount": 1 }, { "do": "flipCard" } ] } ] }
```

---

## 9. Что меняется

### Бэкенд (`dark-omens-relay`)
- Завести модуль `effect-dsl.ts`: TS-типы + JSON-Schema `$defs` Effect-узла —
  **один** набор, переиспользуемый всеми tool-схемами.
- `encounter-prompt.ts`: `successEffects`/`failureEffects` (нынешний `oneOf/allOf`)
  → слоты `onSuccess`/`onFailure` с Effect-программами.
- `campaign-prompt.ts`: `mythosDeck` эффекты → слоты Мифа; добавить генерацию
  библиотеки состояний.
- Системные промпты: объяснить грамматику; few-shot — примеры из раздела 8.
- Это **заменяет** нынешние ad-hoc effect-списки. Рабочая генерация встреч —
  переложится на DSL (разовая правка схемы + промпта).

### Godot (`dark-omens`)
- **Интерпретатор Effect-программы** — обходчик дерева: `Action` через
  `match do:`, плюс `choice` / `test` / `dieRoll` / `repeat` / `when` / `target`.
- Реализация каждого листа (`loseHealth`, `openGate`, …) — большая часть работы.
- Диспетчер триггеров: «расплата» → `onReckoning` всех компонентов; «миф вытянут»
  → `onDraw`; и т.д.
- Библиотека состояний (фиксированный data-файл) + UI карт (показ `text`).

---

## 10. Фазы

1. **Спека-заморозка** — утвердить enum'ы (verbs/targets/predicates/counts) по
   этому документу.
2. **`effect-dsl.ts`** — типы + JSON-Schema, переиспускаемые tool-схемами.
3. **Встречи на DSL** — переложить `encounter-prompt`, проверить генерацию.
4. **Мифы + состояния на DSL** — `campaign-prompt`, генерация библиотеки состояний.
5. **Godot-интерпретатор** — обходчик + листья + диспетчер триггеров (самый
   большой кусок; делается итеративно, непокрытое держится на `text`).
6. **Активы / заклинания / монстры** — добавляются как носители тех же слотов.

DSL **не уменьшает** работу в Godot — добавляет интерпретатор поверх реализации
каждого листа. Но это делается один раз и обслуживает весь контент игры, вместо
трёх несвязанных систем эффектов.
