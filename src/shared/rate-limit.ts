// In-memory rate-limit с fixed-window. Достаточно для MVP — единый процесс,
// нет нужды в Redis. При горизонтальном масштабировании потребуется shared
// store, но к этому моменту проект явно перерастёт «инди-хобби».

interface RateEntry { count: number; resetAt: number; }

const stores = new Map<string, Map<string, RateEntry>>();

function getStore(scope: string): Map<string, RateEntry> {
  let s = stores.get(scope);
  if (!s) { s = new Map(); stores.set(scope, s); }
  return s;
}

// Чистим просроченные записи раз в 5 минут — Map не сборщик мусора, без
// этого таблица будет расти на каждого уникального IP/юзера.
setInterval(() => {
  const now = Date.now();
  for (const store of stores.values()) {
    for (const [k, v] of store) {
      if (v.resetAt < now) store.delete(k);
    }
  }
}, 5 * 60 * 1000);


/**
 * Учитывает попытку в указанном scope. true — разрешено, false — лимит
 * исчерпан. Окно сбрасывается через windowMs с момента первого запроса.
 *
 * scope разделяет неперекрывающиеся пулы (например, "auth-request-email"
 * и "encounter-user" живут в разных таблицах).
 */
export function bumpRate(
  scope: string, key: string, limit: number, windowMs: number,
): boolean {
  const store = getStore(scope);
  const now   = Date.now();
  const entry = store.get(key);
  if (!entry || entry.resetAt < now) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count++;
  return true;
}


/** Сбрасывает все счётчики. Только для тестов. */
export function __resetRateLimitForTests(): void {
  stores.clear();
}


/** Достаёт IP клиента из заголовков (Render/Cloudflare/nginx). */
export function clientIp(headers: { get(name: string): string | undefined }): string {
  return headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      ?? headers.get('x-real-ip')
      ?? 'unknown';
}
