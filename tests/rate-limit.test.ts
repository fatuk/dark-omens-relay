import { describe, it, expect, beforeEach } from 'vitest';
import { bumpRate, clientIp, __resetRateLimitForTests } from '../src/shared/rate-limit.js';

beforeEach(() => { __resetRateLimitForTests(); });


describe('bumpRate', () => {
  it('первые N вызовов разрешены, N+1 — отказ', () => {
    for (let i = 0; i < 5; i++) {
      expect(bumpRate('scope', 'k', 5, 60_000)).toBe(true);
    }
    expect(bumpRate('scope', 'k', 5, 60_000)).toBe(false);
  });

  it('окно сбрасывается по истечении windowMs', () => {
    // Стартуем с маленьким окном (10 мс), забиваем, ждём, проверяем заново.
    expect(bumpRate('scope', 'k', 2, 10)).toBe(true);
    expect(bumpRate('scope', 'k', 2, 10)).toBe(true);
    expect(bumpRate('scope', 'k', 2, 10)).toBe(false);

    return new Promise<void>((resolve) => setTimeout(() => {
      expect(bumpRate('scope', 'k', 2, 10)).toBe(true);
      resolve();
    }, 30));
  });

  it('разные scope изолированы (auth-email vs auth-ip не пересекаются)', () => {
    // Забиваем scopeA для ключа k.
    expect(bumpRate('scopeA', 'k', 1, 60_000)).toBe(true);
    expect(bumpRate('scopeA', 'k', 1, 60_000)).toBe(false);
    // scopeB с тем же ключом — должен иметь свой счётчик.
    expect(bumpRate('scopeB', 'k', 1, 60_000)).toBe(true);
  });

  it('разные key в одном scope считаются независимо', () => {
    expect(bumpRate('scope', 'a', 1, 60_000)).toBe(true);
    expect(bumpRate('scope', 'b', 1, 60_000)).toBe(true);
    // Каждый из них использовал свой лимит — следующие запросы блокируются.
    expect(bumpRate('scope', 'a', 1, 60_000)).toBe(false);
    expect(bumpRate('scope', 'b', 1, 60_000)).toBe(false);
  });

  it('__resetRateLimitForTests чистит все scope', () => {
    expect(bumpRate('s', 'k', 1, 60_000)).toBe(true);
    expect(bumpRate('s', 'k', 1, 60_000)).toBe(false);
    __resetRateLimitForTests();
    expect(bumpRate('s', 'k', 1, 60_000)).toBe(true);
  });
});


describe('clientIp', () => {
  function headers(map: Record<string, string>) {
    return { get: (name: string): string | undefined => map[name.toLowerCase()] };
  }

  it('извлекает первый IP из X-Forwarded-For (Render/proxy случай)', () => {
    expect(clientIp(headers({
      'x-forwarded-for': '203.0.113.1, 10.0.0.1, 172.16.0.1',
    }))).toBe('203.0.113.1');
  });

  it('тримит пробелы вокруг IP в X-Forwarded-For', () => {
    expect(clientIp(headers({
      'x-forwarded-for': '  203.0.113.5  , 10.0.0.1',
    }))).toBe('203.0.113.5');
  });

  it('IPv6 в X-Forwarded-For сохраняется как есть', () => {
    expect(clientIp(headers({
      'x-forwarded-for': '2001:db8::1, 10.0.0.1',
    }))).toBe('2001:db8::1');
  });

  it('падает на X-Real-IP если X-Forwarded-For нет', () => {
    expect(clientIp(headers({
      'x-real-ip': '198.51.100.7',
    }))).toBe('198.51.100.7');
  });

  it('возвращает "unknown" если ни одного заголовка', () => {
    expect(clientIp(headers({}))).toBe('unknown');
  });

  it('X-Forwarded-For приоритетнее X-Real-IP', () => {
    expect(clientIp(headers({
      'x-forwarded-for': '203.0.113.1',
      'x-real-ip':       '198.51.100.7',
    }))).toBe('203.0.113.1');
  });
});
