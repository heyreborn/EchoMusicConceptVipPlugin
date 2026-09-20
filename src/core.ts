import type {
  ClaimOptions,
  ClaimResult,
  ClaimStatus,
  EchoPluginContext,
  PluginSettings,
  PluginState,
  VipService,
} from './types';

export const SETTINGS_KEY = 'settings';
export const STATUS_KEY = 'last-status';

export const DEFAULT_SETTINGS: Readonly<PluginSettings> = Object.freeze({
  autoClaim: false,
  autoUpgrade: false,
  notifySuccess: true,
});

export const EMPTY_STATUS: Readonly<ClaimStatus> = Object.freeze({
  kind: 'idle',
  day: '',
  message: '尚未执行',
  updatedAt: 0,
});

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export const normalizeSettings = (value: unknown): PluginSettings => {
  const source = asRecord(value);
  return {
    autoClaim:
      typeof source?.autoClaim === 'boolean'
        ? source.autoClaim
        : DEFAULT_SETTINGS.autoClaim,
    autoUpgrade:
      typeof source?.autoUpgrade === 'boolean'
        ? source.autoUpgrade
        : DEFAULT_SETTINGS.autoUpgrade,
    notifySuccess:
      typeof source?.notifySuccess === 'boolean'
        ? source.notifySuccess
        : DEFAULT_SETTINGS.notifySuccess,
  };
};

export const normalizeStatus = (value: unknown): ClaimStatus => {
  const source = asRecord(value);
  const validKinds = new Set([
    'idle',
    'checking',
    'claiming',
    'claimed',
    'already-claimed',
    'upgraded',
    'partial',
    'error',
  ]);
  const kind = String(source?.kind ?? '');
  return {
    kind: validKinds.has(kind) ? (kind as ClaimStatus['kind']) : EMPTY_STATUS.kind,
    day: typeof source?.day === 'string' ? source.day : EMPTY_STATUS.day,
    message:
      typeof source?.message === 'string' ? source.message : EMPTY_STATUS.message,
    updatedAt:
      typeof source?.updatedAt === 'number' && Number.isFinite(source.updatedAt)
        ? source.updatedAt
        : EMPTY_STATUS.updatedAt,
  };
};

export const formatChinaDay = (date = new Date()): string => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};

const matchesDay = (value: unknown, day: string): boolean => {
  if (typeof value === 'number') return String(value) === day.replaceAll('-', '');
  if (typeof value !== 'string') return false;
  const normalized = value.trim();
  return (
    normalized === day ||
    normalized === day.replaceAll('-', '') ||
    normalized.startsWith(`${day}T`) ||
    normalized.startsWith(`${day} `)
  );
};

export const hasClaimedDay = (payload: unknown, day: string): boolean => {
  const seen = new WeakSet<object>();

  const visit = (value: unknown, depth: number): boolean => {
    if (matchesDay(value, day)) return true;
    if (depth > 10 || value === null || typeof value !== 'object') return false;
    if (seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) return value.some((item) => visit(item, depth + 1));
    return Object.values(value as Record<string, unknown>).some((item) =>
      visit(item, depth + 1),
    );
  };

  return visit(payload, 0);
};

const findMessage = (value: unknown, depth = 0): string => {
  if (depth > 5) return '';
  if (typeof value === 'string') return value.trim();
  if (value === null || typeof value !== 'object') return '';
  const record = asRecord(value);
  if (record) {
    for (const key of ['msg', 'message', 'error', 'errmsg', 'error_msg']) {
      const candidate = record[key];
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
    for (const candidate of Object.values(record)) {
      const message = findMessage(candidate, depth + 1);
      if (message) return message;
    }
  }
  return '';
};

export const getErrorMessage = (error: unknown, fallback = '操作失败'): string => {
  const record = asRecord(error);
  const response = asRecord(record?.response);
  return (
    findMessage(response?.body) ||
    findMessage(record) ||
    (error instanceof Error ? error.message : '') ||
    fallback
  );
};

export const isAlreadyClaimedError = (error: unknown): boolean =>
  /(已领取|领取过|重复领取|不可重复|already\s*(claimed|received))/i.test(
    getErrorMessage(error, ''),
  );

const getApiMessage = (payload: unknown, fallback: string): string =>
  findMessage(payload) || fallback;

const createResult = (
  patch: Partial<ClaimResult> & Pick<ClaimResult, 'ok' | 'message'>,
): ClaimResult => ({
  claimed: false,
  alreadyClaimed: false,
  upgraded: false,
  ...patch,
});

const saveStatus = async (
  ctx: EchoPluginContext,
  state: PluginState,
  status: ClaimStatus,
) => {
  state.status = status;
  try {
    await ctx.storage.set(STATUS_KEY, status);
  } catch (error) {
    console.warn('[kugou-concept-vip] 保存状态失败', error);
  }
};

export const createVipService = (
  ctx: EchoPluginContext,
  state: PluginState,
): VipService => {
  let claimInFlight: Promise<ClaimResult> | null = null;

  const updateStatus = (
    kind: ClaimStatus['kind'],
    day: string,
    message: string,
  ) => saveStatus(ctx, state, { kind, day, message, updatedAt: Date.now() });

  const refresh = async (): Promise<boolean> => {
    state.refreshing = true;
    const [vipResult, recordResult] = await Promise.allSettled([
      ctx.kugou.user.getUserVipDetail(),
      ctx.kugou.user.getVipMonthRecord(),
    ]);
    state.refreshing = false;
    if (vipResult.status === 'fulfilled') state.vipDetail = vipResult.value;
    if (recordResult.status === 'fulfilled') state.monthRecord = recordResult.value;
    return vipResult.status === 'fulfilled' || recordResult.status === 'fulfilled';
  };

  const runClaim = async (options: ClaimOptions): Promise<ClaimResult> => {
    const source = options.source ?? 'manual';
    const day = formatChinaDay();
    await updateStatus('checking', day, '正在检查领取记录');

    try {
      const record = await ctx.kugou.user.getVipMonthRecord();
      state.monthRecord = record;
      if (hasClaimedDay(record, day)) {
        const message = `${day} 已领取`;
        await updateStatus('already-claimed', day, message);
        if (source === 'manual') ctx.toast.info(message);
        return createResult({ ok: true, alreadyClaimed: true, message });
      }
    } catch (error) {
      if (source === 'auto') {
        const message = `自动领取已跳过：${getErrorMessage(error, '无法确认领取记录')}`;
        await updateStatus('error', day, message);
        return createResult({ ok: false, message });
      }
    }

    await updateStatus('claiming', day, '正在领取当日 VIP');
    let claimResponse: unknown;
    try {
      claimResponse = await ctx.kugou.user.claimDayVip(day);
    } catch (error) {
      if (isAlreadyClaimedError(error)) {
        const message = `${day} 已领取`;
        await updateStatus('already-claimed', day, message);
        if (source === 'manual') ctx.toast.info(message);
        return createResult({ ok: true, alreadyClaimed: true, message });
      }
      const message = getErrorMessage(error, 'VIP 领取失败');
      await updateStatus('error', day, message);
      if (source === 'manual') ctx.toast.danger(message);
      return createResult({ ok: false, message });
    }

    if (state.settings.autoUpgrade) {
      try {
        const upgradeResponse = await ctx.kugou.user.upgradeDayVip();
        const message = getApiMessage(upgradeResponse, 'VIP 已领取并升级为畅听会员');
        await updateStatus('upgraded', day, message);
        if (source === 'manual' || state.settings.notifySuccess) {
          ctx.toast.success(message);
        }
        void refresh();
        return createResult({ ok: true, claimed: true, upgraded: true, message });
      } catch (error) {
        const message = `VIP 已领取，但升级失败：${getErrorMessage(error)}`;
        await updateStatus('partial', day, message);
        if (source === 'manual' || state.settings.notifySuccess) {
          ctx.toast.warning(message);
        }
        void refresh();
        return createResult({ ok: true, claimed: true, message });
      }
    }

    const message = getApiMessage(claimResponse, '今日概念版 VIP 领取成功');
    await updateStatus('claimed', day, message);
    if (source === 'manual' || state.settings.notifySuccess) ctx.toast.success(message);
    void refresh();
    return createResult({ ok: true, claimed: true, message });
  };

  const claimToday = (options: ClaimOptions = {}): Promise<ClaimResult> => {
    if (claimInFlight) return claimInFlight;
    claimInFlight = runClaim(options).finally(() => {
      claimInFlight = null;
    });
    return claimInFlight;
  };

  const upgrade = async (): Promise<ClaimResult> => {
    const day = formatChinaDay();
    try {
      const response = await ctx.kugou.user.upgradeDayVip();
      const message = getApiMessage(response, '已升级为畅听会员');
      await updateStatus('upgraded', day, message);
      ctx.toast.success(message);
      void refresh();
      return createResult({ ok: true, claimed: true, upgraded: true, message });
    } catch (error) {
      const message = getErrorMessage(error, '升级失败');
      await updateStatus('error', day, message);
      ctx.toast.danger(message);
      return createResult({ ok: false, message });
    }
  };

  return { claimToday, upgrade, refresh };
};
