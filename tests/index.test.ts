import { describe, expect, test } from '@rstest/core';
import {
  AUTO_UPGRADE_RETRY_MS,
  DEFAULT_SETTINGS,
  EMPTY_STATUS,
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
  const calls = { claim: 0, upgrade: 0, record: 0 };
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

  test('does not call the upgrade endpoint for an active svip account', async () => {
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
    expect(calls.upgrade).toBe(0);
  });

  test('manual upgrade requires the current day to be claimed', async () => {
    const { ctx, calls } = createContext();
    const result = await createVipService(ctx, createState()).upgrade();
    expect(result.ok).toBe(false);
    expect(calls.upgrade).toBe(0);
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
