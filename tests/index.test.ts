import { describe, expect, test } from '@rstest/core';
import {
  DEFAULT_SETTINGS,
  EMPTY_PERSISTED_STATE,
  addDays,
  buildTargetDates,
  createVipService,
  formatChinaDay,
  isAdLimitResult,
  nextChinaDailyRunAt,
  normalizePersistedState,
  normalizeSettings,
} from '../src/core';
import {
  createKugouClient,
  getEchoKugouAuth,
  md5,
  parseKugouResult,
  signAndroidLite,
} from '../src/kugou';
import type { EchoPluginContext, KugouApiResult, KugouClient, PluginState } from '../src/types';

const success = (message = '成功', data: unknown = null): KugouApiResult => ({
  ok: true,
  code: 0,
  status: 1,
  message,
  data,
  raw: { status: 1, message, data },
});

const failure = (code: number, message: string): KugouApiResult => ({
  ok: false,
  code,
  status: 0,
  message,
  data: null,
  raw: { status: 0, error_code: code, error_msg: message },
});

const createState = (): PluginState => ({
  settings: { ...DEFAULT_SETTINGS, futureDays: 0 },
  persisted: {
    ...EMPTY_PERSISTED_STATE,
    claimedDates: {},
    upgradeDates: {},
    adTaskDates: {},
    futureLimits: {},
    autoRunDates: {},
  },
  running: false,
  cancelRequested: false,
});

const createContext = () => {
  const storage = new Map<string, unknown>();
  const requests: Array<Record<string, unknown>> = [];
  const ctx = {
    id: 'kugou-concept-vip',
    manifest: { name: '酷狗概念版 VIP' },
    pinia: {
      state: {
        value: {
          user: { info: { userid: 123, token: 'secret-token' } },
          device: { info: { mid: 'device-mid', dfid: 'device-dfid', uuid: 'device-uuid' } },
        },
      },
    },
    net: {
      async request(options: Record<string, unknown>) {
        requests.push(options);
        return { url: String(options.url), status: 200, statusText: 'OK', headers: {}, data: { status: 1, data: {} } };
      },
    },
    storage: {
      async get(key: string) {
        return storage.get(key);
      },
      async set(key: string, value: unknown) {
        storage.set(key, value);
      },
    },
    toast: { info() {}, success() {}, warning() {}, danger() {} },
  } as unknown as EchoPluginContext;
  return { ctx, requests, storage };
};

const createClient = (overrides: Partial<KugouClient> = {}) => {
  const calls = { claim: [] as string[], upgrade: 0, ad: 0 };
  const client: KugouClient = {
    getAuth: () => ({ token: 'token', userId: 1, mid: 'mid', dfid: 'dfid', uuid: 'uuid' }),
    async claimDayVip(day) {
      calls.claim.push(day);
      return success('领取成功');
    },
    async upgradeDayVip() {
      calls.upgrade += 1;
      return success('升级成功');
    },
    async reportAdPlay() {
      calls.ad += 1;
      return success('广告任务成功', { done: calls.ad, remain: 8 - calls.ad });
    },
    ...overrides,
  };
  return { client, calls };
};

describe('direct KuGou client', () => {
  test('uses stable MD5 vectors', () => {
    expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
  });

  test('creates deterministic Android Lite signatures', () => {
    const params = { userid: 123, appid: 3116, clienttime: 1 };
    expect(signAndroidLite(params)).toBe(signAndroidLite({ clienttime: 1, appid: 3116, userid: 123 }));
    expect(signAndroidLite(params)).toHaveLength(32);
  });

  test('reads auth from EchoMusic Pinia state', () => {
    const { ctx } = createContext();
    expect(getEchoKugouAuth(ctx)).toEqual({
      token: 'secret-token',
      userId: 123,
      mid: 'device-mid',
      dfid: 'device-dfid',
      uuid: 'device-uuid',
    });
  });

  test('rejects missing login state', () => {
    const { ctx } = createContext();
    ctx.pinia.state.value.user = { info: null };
    expect(() => getEchoKugouAuth(ctx)).toThrow('请先在 EchoMusic 登录酷狗账号');
  });

  test('parses business errors without losing the code', () => {
    expect(parseKugouResult({ status: 0, error_code: 131001, error_msg: '' })).toMatchObject({
      ok: false,
      code: 131001,
      message: '酷狗接口错误 (error_code: 131001)',
    });
  });

  test('sends claims directly through ctx.net', async () => {
    const { ctx, requests } = createContext();
    await createKugouClient(ctx).claimDayVip('2026-09-20');
    expect(requests).toHaveLength(1);
    expect(String(requests[0].url)).toContain('/youth/v1/recharge/receive_vip_listen_song');
    expect(String(requests[0].url)).toContain('receive_day=2026-09-20');
    expect(String(requests[0].url)).toContain('signature=');
  });
});

describe('settings and schedule utilities', () => {
  test('uses the safe automation defaults', () => {
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.delaySeconds).toBe(60);
    expect(normalizeSettings({ futureDays: 99, delaySeconds: -1, adCount: 20 })).toMatchObject({
      futureDays: 7,
      delaySeconds: 0,
      adCount: 8,
    });
  });

  test('builds China-time future dates across month boundaries', () => {
    expect(formatChinaDay(new Date('2026-09-19T16:30:00.000Z'))).toBe('2026-09-20');
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    const dates = buildTargetDates(DEFAULT_SETTINGS, new Date('2026-09-20T02:00:00.000Z'));
    expect(dates).toHaveLength(8);
    expect(dates.at(-1)).toBe('2026-09-27');
  });

  test('schedules the daily task for 09:00 China time', () => {
    expect(nextChinaDailyRunAt(new Date('2026-09-20T00:00:00Z')).toISOString()).toBe('2026-09-20T01:00:00.000Z');
    expect(nextChinaDailyRunAt(new Date('2026-09-20T02:00:00Z')).toISOString()).toBe('2026-09-21T01:00:00.000Z');
  });

  test('normalizes the internal automation state', () => {
    expect(normalizePersistedState({ retryCount: 99, history: [{ id: 'old' }] })).toMatchObject({
      futureLimits: {},
      autoRunDates: {},
      retryCount: 3,
    });
  });

  test('recognizes the exhausted advertising response', () => {
    expect(isAdLimitResult(failure(1, '今天次数已用光'))).toBe(true);
  });
});

describe('automatic task service', () => {
  test('runs today, upgrade, ads and future claims in order', async () => {
    const { ctx } = createContext();
    const state = createState();
    state.settings.futureDays = 2;
    state.settings.autoUpgrade = true;
    state.settings.adEnabled = true;
    state.settings.adCount = 1;
    const order: string[] = [];
    const { client } = createClient({
      claimDayVip: async (day) => { order.push(`claim:${day}`); return success(); },
      upgradeDayVip: async () => { order.push('upgrade'); return success(); },
      reportAdPlay: async () => { order.push('ad'); return success('成功', { done: 1, remain: 0 }); },
    });
    const result = await createVipService(ctx, state, client, {
      now: () => new Date('2026-09-20T02:00:00Z'),
      sleep: async () => {},
    }).runAll();
    expect(result.ok).toBe(true);
    expect(order).toEqual([
      'claim:2026-09-20',
      'upgrade',
      'ad',
      'claim:2026-09-21',
      'claim:2026-09-22',
    ]);
  });

  test('treats already-completed operations as successful no-ops', async () => {
    const { ctx } = createContext();
    const state = createState();
    state.settings.autoUpgrade = true;
    const { client } = createClient({
      claimDayVip: async () => failure(131001, '已经领取'),
      upgradeDayVip: async () => failure(297002, '已经领取过升级'),
    });
    const result = await createVipService(ctx, state, client).runAll();
    expect(result).toMatchObject({ ok: true, changed: false });
  });

  test('caches the daily future limit and avoids repeated requests', async () => {
    const { ctx } = createContext();
    const state = createState();
    state.settings.futureDays = 7;
    const { client, calls } = createClient({
      claimDayVip: async (day) => {
        calls.claim.push(day);
        return day === '2026-09-20' ? success() : failure(131002, '未来时长不足');
      },
    });
    const service = createVipService(ctx, state, client, {
      now: () => new Date('2026-09-20T02:00:00Z'),
      sleep: async () => {},
    });
    const first = await service.runAll();
    const second = await service.runAll();
    expect(first).toMatchObject({ ok: true, limited: true });
    expect(second).toMatchObject({ ok: true, limited: true, changed: false });
    expect(calls.claim).toEqual(['2026-09-20', '2026-09-21']);
    expect(state.persisted.futureLimits['2026-09-20']?.blockedDay).toBe('2026-09-21');
  });

  test('treats exhausted advertising attempts as completed', async () => {
    const { ctx } = createContext();
    const state = createState();
    state.settings.adEnabled = true;
    state.settings.adCount = 8;
    state.persisted.claimedDates['2026-09-20'] = { ok: true, message: '已领取', updatedAt: 1 };
    const { client, calls } = createClient({ reportAdPlay: async () => {
      calls.ad += 1;
      return failure(1, '今天次数已用光');
    } });
    const result = await createVipService(ctx, state, client, {
      now: () => new Date('2026-09-20T02:00:00Z'),
    }).runAll();
    expect(result.ok).toBe(true);
    expect(calls.ad).toBe(1);
    expect(state.persisted.adTaskDates['2026-09-20']?.done).toBe(8);
  });

  test('runs ads with a 35 second interval', async () => {
    const { ctx } = createContext();
    const state = createState();
    state.settings.adEnabled = true;
    state.settings.adCount = 3;
    const waits: number[] = [];
    const { client, calls } = createClient();
    const result = await createVipService(ctx, state, client, {
      now: () => new Date('2026-09-20T02:00:00Z'),
      sleep: async (milliseconds) => { waits.push(milliseconds); },
    }).runAll();
    expect(result.ok).toBe(true);
    expect(calls.ad).toBe(3);
    expect(waits).toEqual([35_000, 35_000]);
  });

  test('marks missing authentication as retryable', async () => {
    const { ctx } = createContext();
    const state = createState();
    const { client } = createClient({ getAuth: () => { throw new Error('请先登录酷狗账号'); } });
    const result = await createVipService(ctx, state, client).runAll();
    expect(result).toMatchObject({ ok: false, retryable: true });
  });

  test('uses a settings snapshot for an active task', async () => {
    const { ctx } = createContext();
    const state = createState();
    state.settings.futureDays = 2;
    state.settings.autoUpgrade = true;
    const { client, calls } = createClient({
      upgradeDayVip: async () => {
        state.settings.futureDays = 0;
        return success();
      },
    });
    const result = await createVipService(ctx, state, client, {
      now: () => new Date('2026-09-20T02:00:00Z'),
      sleep: async () => {},
    }).runAll();
    expect(result.ok).toBe(true);
    expect(calls.claim).toEqual(['2026-09-20', '2026-09-21', '2026-09-22']);
  });

  test('deduplicates concurrent task runs', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { ctx } = createContext();
    const state = createState();
    const { client, calls } = createClient({
      claimDayVip: async (day) => {
        calls.claim.push(day);
        await gate;
        return success();
      },
    });
    const service = createVipService(ctx, state, client);
    const first = service.runAll();
    const second = service.runAll();
    release?.();
    expect(await first).toEqual(await second);
    expect(calls.claim).toHaveLength(1);
  });
});
