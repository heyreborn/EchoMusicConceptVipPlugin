import { describe, expect, test } from '@rstest/core';
import {
  AUTO_UPGRADE_RETRY_MS,
  DEFAULT_SETTINGS,
  EMPTY_STATUS,
  assertApiSuccess,
  createVipService,
  formatChinaDay,
  getErrorMessage,
  hasActiveSvip,
  hasClaimedDay,
  isAlreadyClaimedError,
  normalizeSettings,
} from '../src/core';
import type { EchoPluginContext, PluginState } from '../src/types';

const createState = (): PluginState => ({
  settings: { ...DEFAULT_SETTINGS },
  status: { ...EMPTY_STATUS },
  monthRecord: null,
  vipDetail: null,
  refreshing: false,
});

const createContext = (overrides: Partial<EchoPluginContext['kugou']['user']> = {}) => {
  const storage = new Map<string, unknown>();
  const calls = { claim: 0, upgrade: 0, record: 0, detail: 0 };
  const ctx = {
    id: 'kugou-concept-vip',
    manifest: { name: '酷狗概念版 VIP' },
    kugou: {
      user: {
        async claimDayVip() {
          calls.claim += 1;
          return { status: 1, msg: '领取成功' };
        },
        async upgradeDayVip() {
          calls.upgrade += 1;
          return { status: 1, msg: '升级成功' };
        },
        async getVipMonthRecord() {
          calls.record += 1;
          return { status: 1, data: [] };
        },
        async getUserVipDetail() {
          calls.detail += 1;
          return { status: 1, data: {} };
        },
        ...overrides,
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
  return { ctx, calls, storage };
};

describe('core utilities', () => {
  test('uses China time when producing the claim day', () => {
    expect(formatChinaDay(new Date('2026-09-19T16:30:00.000Z'))).toBe('2026-09-20');
  });

  test('normalizes persisted settings', () => {
    expect(normalizeSettings({ autoClaim: true, autoUpgrade: 'yes' })).toEqual({
      autoClaim: true,
      autoUpgrade: false,
      notifySuccess: true,
    });
  });

  test('finds claimed dates in nested response shapes', () => {
    expect(
      hasClaimedDay({ data: { records: [{ receive_day: '2026-09-20' }] } }, '2026-09-20'),
    ).toBe(true);
    expect(hasClaimedDay({ data: ['20260920'] }, '2026-09-20')).toBe(true);
    expect(hasClaimedDay({ data: [{ receive_day: '2026-09-19' }] }, '2026-09-20')).toBe(
      false,
    );
  });

  test('does not treat unrelated response dates as claim records', () => {
    expect(
      hasClaimedDay(
        {
          status: 1,
          server_day: '2026-09-20',
          data: { activity_start: '2026-09-20', records: [] },
        },
        '2026-09-20',
      ),
    ).toBe(false);
  });

  test('detects an active svip from the VIP detail response', () => {
    expect(
      hasActiveSvip({
        status: 1,
        data: { busi_vip: [{ product_type: 'svip', is_vip: 1 }] },
      }),
    ).toBe(true);
    expect(
      hasActiveSvip({ data: { busi_vip: [{ product_type: 'svip', is_vip: 0 }] } }),
    ).toBe(false);
  });

  test('extracts KuGou API error messages', () => {
    const error = { response: { body: { status: 0, msg: '今日已领取' } } };
    expect(getErrorMessage(error)).toBe('今日已领取');
    expect(isAlreadyClaimedError(error)).toBe(true);
  });

  test('shows the KuGou error code when a 502 response has no message', () => {
    const error = Object.assign(new Error('API Error: 502'), {
      response: {
        status: 502,
        body: { status: 0, error_code: 20028, error_msg: '' },
      },
    });
    expect(getErrorMessage(error)).toBe('酷狗接口错误 (error_code: 20028)');
  });

  test('rejects resolved KuGou business failures', () => {
    expect(() =>
      assertApiSuccess(
        { status: 0, error_code: 20028, error_msg: '领取条件不满足' },
        'VIP 领取失败',
      ),
    ).toThrow('领取条件不满足');
  });
});

describe('VIP service', () => {
  test('does not claim again when the month record contains today', async () => {
    const today = formatChinaDay();
    const { ctx, calls } = createContext({
      async getVipMonthRecord() {
        calls.record += 1;
        return { status: 1, data: [{ receive_day: today }] };
      },
    });
    const result = await createVipService(ctx, createState()).claimToday();
    expect(result.ok).toBe(true);
    expect(result.alreadyClaimed).toBe(true);
    expect(calls.claim).toBe(0);
  });

  test('claims and upgrades when auto upgrade is enabled', async () => {
    const { ctx, calls } = createContext();
    const state = createState();
    state.settings.autoUpgrade = true;
    const result = await createVipService(ctx, state).claimToday();
    expect(result).toMatchObject({ ok: true, claimed: true, upgraded: true });
    expect(calls.claim).toBe(1);
    expect(calls.upgrade).toBe(1);
  });

  test('upgrades an already claimed day when auto upgrade is enabled', async () => {
    const today = formatChinaDay();
    const { ctx, calls } = createContext({
      async getVipMonthRecord() {
        calls.record += 1;
        return { status: 1, data: [{ receive_day: today }] };
      },
    });
    const state = createState();
    state.settings.autoUpgrade = true;
    const result = await createVipService(ctx, state).claimToday({ source: 'auto' });
    expect(result).toMatchObject({ ok: true, claimed: true, upgraded: true });
    expect(calls.claim).toBe(0);
    expect(calls.upgrade).toBe(1);
  });

  test('lets the upgrade endpoint decide even when SVIP detail is active', async () => {
    const today = formatChinaDay();
    const { ctx, calls } = createContext({
      async getVipMonthRecord() {
        calls.record += 1;
        return { status: 1, data: [{ receive_day: today }] };
      },
      async getUserVipDetail() {
        return {
          status: 1,
          data: { busi_vip: [{ product_type: 'svip', is_vip: 1 }] },
        };
      },
    });
    const state = createState();
    state.settings.autoUpgrade = true;
    const result = await createVipService(ctx, state).claimToday();
    expect(result).toMatchObject({ ok: true, upgraded: true });
    expect(calls.upgrade).toBe(1);
  });

  test('manual upgrade lets the upgrade endpoint decide eligibility', async () => {
    const { ctx, calls } = createContext({
      async getVipMonthRecord() {
        calls.record += 1;
        throw new Error('network unavailable');
      },
    });
    const result = await createVipService(ctx, createState()).upgrade();
    expect(result.ok).toBe(true);
    expect(calls.upgrade).toBe(1);
  });

  test('manual upgrade reports the endpoint prerequisite error without assuming a claim', async () => {
    const { ctx, calls } = createContext({
      async upgradeDayVip() {
        calls.upgrade += 1;
        throw { response: { body: { status: 0, msg: '请先领取今日 VIP' } } };
      },
    });
    const state = createState();
    const result = await createVipService(ctx, state).upgrade();
    expect(result).toMatchObject({ ok: false, claimed: false });
    expect(result.message).toContain('请先领取今日 VIP');
    expect(state.status.kind).toBe('error');
    expect(calls.upgrade).toBe(1);
  });

  test('does not report a resolved claim business failure as success', async () => {
    const { ctx } = createContext({
      async claimDayVip() {
        return { status: 0, error_code: 20028, error_msg: '领取条件不满足' };
      },
    });
    const state = createState();
    const result = await createVipService(ctx, state).claimToday();
    expect(result).toMatchObject({ ok: false, claimed: false });
    expect(result.message).toBe('领取条件不满足');
    expect(state.status.kind).toBe('error');
  });

  test('refresh only uses the authoritative claim record endpoint', async () => {
    const { ctx, calls } = createContext({
      async getUserVipDetail() {
        return { status: 0, error_code: 20010, error_msg: '登录已过期' };
      },
    });
    const state = createState();
    const result = await createVipService(ctx, state).refresh();
    expect(result).toBe(true);
    expect(state.vipDetail).toBeNull();
    expect(state.monthRecord).not.toBeNull();
    expect(state.refreshing).toBe(false);
    expect(state.status).toMatchObject({ kind: 'idle' });
    expect(calls.detail).toBe(0);
  });

  test('refresh exposes an error code when a query returns a message-less 502', async () => {
    const { ctx } = createContext({
      async getVipMonthRecord() {
        throw Object.assign(new Error('API Error: 502'), {
          response: {
            status: 502,
            body: { status: 0, error_code: 20028, error_msg: '' },
          },
        });
      },
    });
    const state = createState();
    const result = await createVipService(ctx, state).refresh();
    expect(result).toBe(false);
    expect(state.status.message).toContain('error_code: 20028');
  });

  test('background refresh failure does not overwrite a successful operation status', async () => {
    const { ctx } = createContext({
      async getVipMonthRecord() {
        throw new Error('network unavailable');
      },
    });
    const state = createState();
    state.status = {
      kind: 'claimed',
      day: formatChinaDay(),
      message: '领取成功',
      updatedAt: Date.now(),
    };
    const result = await createVipService(ctx, state).refresh({ reportFailure: false });
    expect(result).toBe(false);
    expect(state.status.kind).toBe('claimed');
  });

  test('refresh derives today claimed status from the month record', async () => {
    const today = formatChinaDay();
    const { ctx } = createContext({
      async getVipMonthRecord() {
        return { status: 1, data: [{ receive_day: today }] };
      },
    });
    const state = createState();
    const result = await createVipService(ctx, state).refresh();
    expect(result).toBe(true);
    expect(state.status).toMatchObject({ kind: 'already-claimed', day: today });
  });

  test('successful refresh clears a stale error from the current day', async () => {
    const today = formatChinaDay();
    const { ctx } = createContext();
    const state = createState();
    state.status = {
      kind: 'error',
      day: today,
      message: '酷狗接口错误 (error_code: 131001)',
      updatedAt: Date.now(),
    };
    const result = await createVipService(ctx, state).refresh();
    expect(result).toBe(true);
    expect(state.status).toMatchObject({ kind: 'idle', day: today, message: '领取记录已刷新' });
  });

  test('refresh preserves a successful status when records do not expose dates', async () => {
    const today = formatChinaDay();
    const { ctx } = createContext({
      async getVipMonthRecord() {
        return { status: 1, data: { claimed_days: 3 } };
      },
    });
    const state = createState();
    state.status = {
      kind: 'claimed',
      day: today,
      message: '领取成功',
      updatedAt: Date.now(),
    };
    const result = await createVipService(ctx, state).refresh();
    expect(result).toBe(true);
    expect(state.status).toMatchObject({ kind: 'claimed', day: today, message: '领取成功' });
  });

  test('delays repeated automatic upgrade attempts after a recent failure', async () => {
    const today = formatChinaDay();
    const { ctx, calls } = createContext({
      async getVipMonthRecord() {
        calls.record += 1;
        return { status: 1, data: [{ receive_day: today }] };
      },
    });
    const state = createState();
    state.settings.autoUpgrade = true;
    const failedAt = Date.now() - AUTO_UPGRADE_RETRY_MS + 1000;
    state.status = {
      kind: 'partial',
      day: today,
      message: '上次升级失败',
      updatedAt: failedAt,
    };
    const result = await createVipService(ctx, state).claimToday({ source: 'auto' });
    expect(result).toMatchObject({ ok: true, claimed: true, upgraded: false });
    expect(calls.upgrade).toBe(0);
    expect(state.status).toMatchObject({ kind: 'partial', updatedAt: failedAt });
  });

  test('auto mode fails closed when the record cannot be checked', async () => {
    const { ctx, calls } = createContext({
      async getVipMonthRecord() {
        calls.record += 1;
        throw new Error('network unavailable');
      },
    });
    const result = await createVipService(ctx, createState()).claimToday({ source: 'auto' });
    expect(result.ok).toBe(false);
    expect(calls.claim).toBe(0);
  });

  test('deduplicates concurrent claim requests', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { ctx, calls } = createContext({
      async claimDayVip() {
        calls.claim += 1;
        await gate;
        return { status: 1, msg: '领取成功' };
      },
    });
    const service = createVipService(ctx, createState());
    const first = service.claimToday();
    const second = service.claimToday();
    release?.();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(calls.claim).toBe(1);
    expect(firstResult).toEqual(secondResult);
  });
});
