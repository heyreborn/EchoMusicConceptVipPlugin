import type {
  ClaimOptions,
  ClaimResult,
  ClaimStatus,
  EchoPluginContext,
  PluginSettings,
  PluginState,
  RefreshOptions,
  VipService,
} from './types';

export const SETTINGS_KEY = 'settings';
export const STATUS_KEY = 'last-status';
export const AUTO_UPGRADE_RETRY_MS = 6 * 60 * 60 * 1000;

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
    'upgrading',
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

const CLAIM_DAY_KEYS = new Set([
  'receive_day',
  'received_day',
  'receive_date',
  'received_date',
  'claim_day',
  'claimed_day',
]);

const CLAIM_RECORD_KEYS = new Set([
  'data',
  'list',
  'records',
  'record_list',
  'days',
  'receive_days',
  'received_days',
  'vip_records',
]);

export const hasClaimedDay = (payload: unknown, day: string): boolean => {
  const seen = new WeakSet<object>();

  const visit = (value: unknown, depth: number, allowDateValue = false): boolean => {
    if (allowDateValue && matchesDay(value, day)) return true;
    if (depth > 10 || value === null || typeof value !== 'object') return false;
    if (seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) {
      return value.some((item) => visit(item, depth + 1, allowDateValue));
    }

    return Object.entries(value as Record<string, unknown>).some(([key, item]) => {
      const normalizedKey = key.toLowerCase();
      if (CLAIM_DAY_KEYS.has(normalizedKey)) return matchesDay(item, day);
      return visit(item, depth + 1, CLAIM_RECORD_KEYS.has(normalizedKey));
    });
  };

  return visit(payload, 0);
};

export const hasActiveSvip = (payload: unknown): boolean => {
  const seen = new WeakSet<object>();

  const visit = (value: unknown, depth: number): boolean => {
    if (depth > 10 || value === null || typeof value !== 'object') return false;
    if (seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) return value.some((item) => visit(item, depth + 1));

    const record = value as Record<string, unknown>;
    if (
      String(record.product_type ?? '').toLowerCase() === 'svip' &&
      Number(record.is_vip) === 1
    ) {
      return true;
    }
    return Object.values(record).some((item) => visit(item, depth + 1));
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

const getApiErrorCode = (payload: Record<string, unknown>): string => {
  for (const key of ['error_code', 'err_code', 'errcode']) {
    const value = payload[key];
    if (value !== undefined && value !== null && String(value) !== '0') {
      return `${key}: ${String(value)}`;
    }
  }
  return '';
};

export const getErrorMessage = (error: unknown, fallback = '操作失败'): string => {
  const record = asRecord(error);
  const response = asRecord(record?.response);
  const responseBody = asRecord(response?.body);
  const responseErrorCode = responseBody ? getApiErrorCode(responseBody) : '';
  return (
    findMessage(response?.body) ||
    (responseErrorCode ? `酷狗接口错误 (${responseErrorCode})` : '') ||
    findMessage(record) ||
    (error instanceof Error ? error.message : '') ||
    fallback
  );
};

export const assertApiSuccess = (payload: unknown, fallback: string): unknown => {
  const record = asRecord(payload);
  if (!record) throw new Error(fallback);

  const statusFailed =
    record.status !== undefined && Number(record.status) !== 1;
  const successFailed = record.success === false;
  const errorCode = getApiErrorCode(record);
  if (statusFailed || successFailed || errorCode) {
    const detail = getApiMessage(payload, '');
    throw new Error(detail || (errorCode ? `${fallback} (${errorCode})` : fallback));
  }
  return payload;
};

export const isAlreadyClaimedError = (error: unknown): boolean =>
  /(已领取|领取过|重复领取|不可重复|already\s*(claimed|received))/i.test(
    getErrorMessage(error, ''),
  );

export const isAlreadyUpgradedError = (error: unknown): boolean =>
  /(已升级|无需升级|重复升级|already\s*upgrad)/i.test(getErrorMessage(error, ''));

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
  let operationInFlight: Promise<ClaimResult> | null = null;

  const updateStatus = (
    kind: ClaimStatus['kind'],
    day: string,
    message: string,
  ) => saveStatus(ctx, state, { kind, day, message, updatedAt: Date.now() });

  const refresh = async (options: RefreshOptions = {}): Promise<boolean> => {
    state.refreshing = true;
    const [vipResult, recordResult] = await Promise.allSettled([
      ctx.kugou.user
        .getUserVipDetail()
        .then((result) => assertApiSuccess(result, '会员信息刷新失败')),
      ctx.kugou.user
        .getVipMonthRecord()
        .then((result) => assertApiSuccess(result, '领取记录刷新失败')),
    ]);
    state.refreshing = false;
    if (vipResult.status === 'fulfilled') state.vipDetail = vipResult.value;
    if (recordResult.status === 'fulfilled') state.monthRecord = recordResult.value;
    const day = formatChinaDay();
    const failures = [
      vipResult.status === 'rejected'
        ? `会员信息：${getErrorMessage(vipResult.reason, '查询失败')}`
        : '',
      recordResult.status === 'rejected'
        ? `领取记录：${getErrorMessage(recordResult.reason, '查询失败')}`
        : '',
    ].filter(Boolean);
    if (failures.length > 0) {
      if (options.reportFailure !== false) {
        await updateStatus('error', day, `状态刷新失败：${failures.join('；')}`);
      }
      return false;
    }
    if (recordResult.status === 'fulfilled' && hasClaimedDay(recordResult.value, day)) {
      await updateStatus('already-claimed', day, `${day} 已领取`);
    } else if (vipResult.status === 'fulfilled' && recordResult.status === 'fulfilled') {
      const currentIsToday = state.status.day === day && state.status.kind !== 'idle';
      if (!currentIsToday) await updateStatus('idle', day, '会员状态和领取记录已刷新');
    }
    return vipResult.status === 'fulfilled' && recordResult.status === 'fulfilled';
  };

  const runExclusive = (operation: () => Promise<ClaimResult>): Promise<ClaimResult> => {
    if (operationInFlight) return operationInFlight;
    operationInFlight = operation().finally(() => {
      operationInFlight = null;
    });
    return operationInFlight;
  };

  const finishAlreadyUpgraded = async (day: string, source: 'manual' | 'auto') => {
    const message = '当前账号已是畅听会员';
    await updateStatus('upgraded', day, message);
    if (source === 'manual') ctx.toast.info(message);
    return createResult({
      ok: true,
      claimed: true,
      alreadyClaimed: true,
      upgraded: true,
      message,
    });
  };

  const shouldDelayAutoUpgradeRetry = (day: string, previousStatus: ClaimStatus | null) =>
    previousStatus?.kind === 'partial' &&
    previousStatus.day === day &&
    Date.now() - previousStatus.updatedAt < AUTO_UPGRADE_RETRY_MS;

  const performUpgrade = async (
    day: string,
    source: 'manual' | 'auto',
    knownClaimed: boolean,
    previousStatus: ClaimStatus | null = state.status,
  ): Promise<ClaimResult> => {
    if (source === 'auto' && shouldDelayAutoUpgradeRetry(day, previousStatus)) {
      state.status = previousStatus as ClaimStatus;
      const message = previousStatus?.message || '升级稍后自动重试';
      return createResult({ ok: true, claimed: true, message });
    }

    if (!knownClaimed && source === 'auto') {
      try {
        const record = assertApiSuccess(
          await ctx.kugou.user.getVipMonthRecord(),
          '领取记录查询失败',
        );
        state.monthRecord = record;
        if (!hasClaimedDay(record, day)) {
          const message = '请先领取今日 VIP，再升级畅听会员';
          await updateStatus('idle', day, message);
          return createResult({ ok: false, message });
        }
      } catch (error) {
        const message = `自动升级已跳过：${getErrorMessage(error, '无法确认领取记录')}`;
        await updateStatus('error', day, message);
        return createResult({ ok: false, message });
      }
    }

    if (previousStatus?.kind === 'upgraded' && previousStatus.day === day) {
      return finishAlreadyUpgraded(day, source);
    }

    await updateStatus('upgrading', day, '正在升级畅听会员');
    try {
      const response = assertApiSuccess(
        await ctx.kugou.user.upgradeDayVip(),
        '畅听会员升级失败',
      );
      const message = getApiMessage(response, '已升级为畅听会员');
      await updateStatus('upgraded', day, message);
      if (source === 'manual' || state.settings.notifySuccess) ctx.toast.success(message);
      void refresh({ reportFailure: false });
      return createResult({ ok: true, claimed: true, upgraded: true, message });
    } catch (error) {
      if (isAlreadyUpgradedError(error)) {
        return finishAlreadyUpgraded(day, source);
      }
      const message = knownClaimed
        ? `VIP 已领取，但升级失败：${getErrorMessage(error)}`
        : `畅听会员升级失败：${getErrorMessage(error)}`;
      await updateStatus(knownClaimed ? 'partial' : 'error', day, message);
      if (source === 'manual' || state.settings.notifySuccess) ctx.toast.warning(message);
      return createResult({ ok: false, claimed: knownClaimed, message });
    }
  };

  const runClaim = async (options: ClaimOptions): Promise<ClaimResult> => {
    const source = options.source ?? 'manual';
    const day = formatChinaDay();
    const previousStatus = state.status;
    await updateStatus('checking', day, '正在检查领取记录');

    try {
      const record = assertApiSuccess(
        await ctx.kugou.user.getVipMonthRecord(),
        '领取记录查询失败',
      );
      state.monthRecord = record;
      if (hasClaimedDay(record, day)) {
        if (state.settings.autoUpgrade) {
          return performUpgrade(day, source, true, previousStatus);
        }
        const message = `${day} 已领取`;
        await updateStatus('already-claimed', day, message);
        if (source === 'manual') ctx.toast.info(message);
        return createResult({ ok: true, claimed: true, alreadyClaimed: true, message });
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
      claimResponse = assertApiSuccess(
        await ctx.kugou.user.claimDayVip(day),
        'VIP 领取失败',
      );
    } catch (error) {
      if (isAlreadyClaimedError(error)) {
        if (state.settings.autoUpgrade) {
          return performUpgrade(day, source, true, previousStatus);
        }
        const message = `${day} 已领取`;
        await updateStatus('already-claimed', day, message);
        if (source === 'manual') ctx.toast.info(message);
        return createResult({ ok: true, claimed: true, alreadyClaimed: true, message });
      }
      const message = getErrorMessage(error, 'VIP 领取失败');
      await updateStatus('error', day, message);
      if (source === 'manual') ctx.toast.danger(message);
      return createResult({ ok: false, message });
    }

    if (state.settings.autoUpgrade) {
      return performUpgrade(day, source, true, null);
    }

    const message = getApiMessage(claimResponse, '今日概念版 VIP 领取成功');
    await updateStatus('claimed', day, message);
    if (source === 'manual' || state.settings.notifySuccess) ctx.toast.success(message);
    void refresh({ reportFailure: false });
    return createResult({ ok: true, claimed: true, message });
  };

  const claimToday = (options: ClaimOptions = {}): Promise<ClaimResult> => {
    return runExclusive(() => runClaim(options));
  };

  const upgrade = (): Promise<ClaimResult> =>
    runExclusive(() => performUpgrade(formatChinaDay(), 'manual', false));

  return { claimToday, upgrade, refresh };
};
