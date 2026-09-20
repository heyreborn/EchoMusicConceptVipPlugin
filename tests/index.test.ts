import { describe, expect, test } from '@rstest/core';
import {
  DEFAULT_SETTINGS,
  EMPTY_PERSISTED_STATE,
  EMPTY_STATUS,
  addDays,
  buildTargetDates,
  createVipService,
  formatChinaDay,
  formatVipText,
  hasClaimedDay,
  normalizeSettings,
} from '../src/core';
import {
  createKugouClient,
  getEchoKugouAuth,
  md5,
  parseKugouResult,
  signAndroidLite,
} from '../src/kugou';
import type {
  EchoPluginContext,
  KugouApiResult,
  KugouClient,
  PluginState,
} from '../src/types';

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
    history: [],
  },
  status: { ...EMPTY_STATUS },
  monthRecord: null,
  vipDetail: null,
  vipText: '',
  running: false,
  cancelRequested: false,
  progress: { phase: 'idle', current: 0, total: 0, label: '' },
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
  const calls = { claim: [] as string[], record: 0, vip: 0, upgrade: 0, ad: 0 };
  const client: KugouClient = {
    getAuth: () => ({ token: 'token', userId: 1, mid: 'mid', dfid: 'dfid', uuid: 'uuid' }),
    async claimDayVip(day) {
      calls.claim.push(day);
      return success('领取成功');
    },
    async getMonthVipRecord() {
      calls.record += 1;
      return success('成功', []);
    },
    async getUnionVip() {
      calls.vip += 1;
      return success('成功', { busi_vip: [] });
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

describe('date and response utilities', () => {
  test('uses China time and crosses month boundaries', () => {
    expect(formatChinaDay(new Date('2026-09-19T16:30:00.000Z'))).toBe('2026-09-20');
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
  });

  test('builds today plus seven future days by default', () => {
    const dates = buildTargetDates(DEFAULT_SETTINGS, new Date('2026-09-20T02:00:00.000Z'));
    expect(dates).toHaveLength(8);
    expect(dates[0]).toBe('2026-09-20');
    expect(dates[7]).toBe('2026-09-27');
  });

  test('normalizes safe defaults', () => {
    expect(normalizeSettings({ futureDays: 99, delaySeconds: -1, adCount: 20 })).toMatchObject({
      autoClaim: false,
      futureDays: 7,
      delaySeconds: 0,
      adEnabled: false,
      adCount: 8,
    });
  });

  test('finds claimed days and formats membership status', () => {
    expect(hasClaimedDay({ data: { records: [{ receive_day: '2026-09-20' }] } }, '2026-09-20')).toBe(true);
    expect(
      formatVipText({ data: { busi_vip: [{ product_type: 'svip', is_vip: 1, vip_end_time: 1790000000 }] } }),
    ).toContain('概念会员：生效中');
  });
});

describe('task service', () => {
  test('claims the configured date range sequentially', async () => {
    const { ctx } = createContext();
    const { client, calls } = createClient();
    const state = createState();
    state.settings.futureDays = 2;
    const service = createVipService(ctx, state, client, {
      now: () => new Date('2026-09-20T02:00:00Z'),
      sleep: async () => {},
    });
    const result = await service.claimConfigured();
    expect(result.ok).toBe(true);
    expect(calls.claim).toEqual(['2026-09-20', '2026-09-21', '2026-09-22']);
    expect(Object.keys(state.persisted.claimedDates)).toHaveLength(3);
  });

  test('treats code 131001 as already claimed only in claim flow', async () => {
    const { ctx } = createContext();
    const { client } = createClient({ claimDayVip: async () => failure(131001, '酷狗接口错误') });
    const state = createState();
    const result = await createVipService(ctx, state, client).claimToday();
    expect(result).toMatchObject({ ok: true, alreadyClaimed: true });
    expect(state.persisted.claimedDates[formatChinaDay()]?.already).toBe(true);
  });

  test('stops future claims after auth expiration', async () => {
    const { ctx } = createContext();
    const { client, calls } = createClient({ claimDayVip: async (day) => {
      calls.claim.push(day);
      return failure(20018, '登录已过期');
    } });
    const state = createState();
    state.settings.futureDays = 7;
    const result = await createVipService(ctx, state, client).claimConfigured();
    expect(result.ok).toBe(false);
    expect(calls.claim).toHaveLength(1);
  });

  test('runs ads with an interval after the first report', async () => {
    const { ctx } = createContext();
    const { client, calls } = createClient();
    const waits: number[] = [];
    const state = createState();
    state.settings.adEnabled = true;
    state.settings.adCount = 3;
    const result = await createVipService(ctx, state, client, {
      sleep: async (milliseconds) => { waits.push(milliseconds); },
    }).runAds();
    expect(result.ok).toBe(true);
    expect(calls.ad).toBe(3);
    expect(waits).toEqual([35_000, 35_000]);
  });

  test('cancels remaining ad reports during the interval', async () => {
    const { ctx } = createContext();
    const { client, calls } = createClient();
    const state = createState();
    state.settings.adEnabled = true;
    state.settings.adCount = 3;
    let service: ReturnType<typeof createVipService>;
    service = createVipService(ctx, state, client, {
      sleep: async () => {
        service.cancel();
      },
    });
    const result = await service.runAds();
    expect(result.canceled).toBe(true);
    expect(calls.ad).toBe(1);
  });

  test('converts missing auth into a visible failed result', async () => {
    const { ctx } = createContext();
    const { client } = createClient({
      getAuth: () => {
        throw new Error('请先在 EchoMusic 登录酷狗账号');
      },
    });
    const state = createState();
    const result = await createVipService(ctx, state, client).claimToday();
    expect(result).toMatchObject({ ok: false, message: '请先在 EchoMusic 登录酷狗账号' });
    expect(state.status.kind).toBe('error');
    expect(state.persisted.history).toHaveLength(1);
  });

  test('runs claim, ads and upgrade in order', async () => {
    const { ctx } = createContext();
    const order: string[] = [];
    const { client } = createClient({
      claimDayVip: async () => { order.push('claim'); return success(); },
      reportAdPlay: async () => { order.push('ad'); return success('成功', { done: 1, remain: 0 }); },
      upgradeDayVip: async () => { order.push('upgrade'); return success(); },
    });
    const state = createState();
    state.settings.adEnabled = true;
    state.settings.adCount = 1;
    state.settings.autoUpgrade = true;
    const result = await createVipService(ctx, state, client).runAll();
    expect(result.ok).toBe(true);
    expect(order).toEqual(['claim', 'ad', 'upgrade']);
    expect(state.persisted.history).toHaveLength(1);
  });

  test('does not let membership query failure override a successful record refresh', async () => {
    const today = formatChinaDay();
    const { ctx } = createContext();
    const { client } = createClient({
      getMonthVipRecord: async () => success('成功', [{ receive_day: today }]),
      getUnionVip: async () => failure(131001, '接口错误'),
    });
    const state = createState();
    const result = await createVipService(ctx, state, client).refresh();
    expect(result).toBe(true);
    expect(state.status.kind).toBe('already-claimed');
    expect(state.vipText).toContain('查询失败');
  });

  test('deduplicates concurrent operations', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { ctx } = createContext();
    const { client, calls } = createClient({
      claimDayVip: async (day) => {
        calls.claim.push(day);
        await gate;
        return success();
      },
    });
    const service = createVipService(ctx, createState(), client);
    const first = service.claimToday();
    const second = service.claimToday();
    release?.();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(calls.claim).toHaveLength(1);
    expect(firstResult).toEqual(secondResult);
  });
});
