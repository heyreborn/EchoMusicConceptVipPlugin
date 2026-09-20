import type {
  ClaimResult,
  ClaimStatus,
  EchoPluginContext,
  HistoryEntry,
  KugouApiResult,
  KugouClient,
  PersistedState,
  PluginSettings,
  PluginState,
  RefreshOptions,
  RunOptions,
  VipService,
} from './types';

export const SETTINGS_KEY = 'settings-v2';
export const STATE_KEY = 'state-v2';
export const AD_TASK_INTERVAL_MS = 35_000;
export const CLAIM_TASK_INTERVAL_MS = 1_200;
export const MAX_HISTORY = 20;

export const DEFAULT_SETTINGS: Readonly<PluginSettings> = Object.freeze({
  autoClaim: false,
  autoUpgrade: false,
  notifySuccess: true,
  futureDays: 7,
  delaySeconds: 60,
  adEnabled: false,
  adCount: 8,
});

export const EMPTY_STATUS: Readonly<ClaimStatus> = Object.freeze({
  kind: 'idle',
  day: '',
  message: '尚未执行',
  updatedAt: 0,
});

export const EMPTY_PERSISTED_STATE: Readonly<PersistedState> = Object.freeze({
  claimedDates: {},
  upgradeDates: {},
  adTaskDates: {},
  history: [],
  lastResult: '',
});

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const clampInteger = (value: unknown, minimum: number, maximum: number, fallback: number) => {
  const parsed = Math.round(Number(value));
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
};

export const normalizeSettings = (value: unknown): PluginSettings => {
  const source = asRecord(value);
  return {
    autoClaim: typeof source?.autoClaim === 'boolean' ? source.autoClaim : DEFAULT_SETTINGS.autoClaim,
    autoUpgrade:
      typeof source?.autoUpgrade === 'boolean' ? source.autoUpgrade : DEFAULT_SETTINGS.autoUpgrade,
    notifySuccess:
      typeof source?.notifySuccess === 'boolean' ? source.notifySuccess : DEFAULT_SETTINGS.notifySuccess,
    futureDays: clampInteger(source?.futureDays, 0, 7, DEFAULT_SETTINGS.futureDays),
    delaySeconds: clampInteger(source?.delaySeconds, 0, 60, DEFAULT_SETTINGS.delaySeconds),
    adEnabled: typeof source?.adEnabled === 'boolean' ? source.adEnabled : DEFAULT_SETTINGS.adEnabled,
    adCount: clampInteger(source?.adCount, 0, 8, DEFAULT_SETTINGS.adCount),
  };
};

export const normalizePersistedState = (value: unknown): PersistedState => {
  const source = asRecord(value);
  return {
    claimedDates: (asRecord(source?.claimedDates) ?? {}) as PersistedState['claimedDates'],
    upgradeDates: (asRecord(source?.upgradeDates) ?? {}) as PersistedState['upgradeDates'],
    adTaskDates: (asRecord(source?.adTaskDates) ?? {}) as PersistedState['adTaskDates'],
    history: Array.isArray(source?.history)
      ? (source.history as HistoryEntry[]).slice(0, MAX_HISTORY)
      : [],
    lastResult: typeof source?.lastResult === 'string' ? source.lastResult : '',
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

export const addDays = (day: string, amount: number): string => {
  const [year, month, date] = day.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, date + amount, 12));
  return next.toISOString().slice(0, 10);
};

export const buildTargetDates = (settings: PluginSettings, now = new Date()): string[] => {
  const today = formatChinaDay(now);
  return Array.from({ length: settings.futureDays + 1 }, (_, index) => addDays(today, index));
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
    if (Array.isArray(value)) return value.some((item) => visit(item, depth + 1, allowDateValue));
    return Object.entries(value as Record<string, unknown>).some(([key, item]) => {
      const normalizedKey = key.toLowerCase();
      if (CLAIM_DAY_KEYS.has(normalizedKey)) return matchesDay(item, day);
      return visit(item, depth + 1, CLAIM_RECORD_KEYS.has(normalizedKey));
    });
  };
  return visit(payload, 0);
};

const findBusiVip = (payload: unknown): Record<string, unknown>[] => {
  const stack = [payload];
  const seen = new WeakSet<object>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    for (const [key, value] of Object.entries(current as Record<string, unknown>)) {
      if (key === 'busi_vip' && Array.isArray(value)) {
        return value.filter((item): item is Record<string, unknown> => Boolean(asRecord(item)));
      }
      if (value && typeof value === 'object') stack.push(value);
    }
  }
  return [];
};

const formatEndTime = (value: unknown): string => {
  if (value === null || value === undefined || value === '') return '';
  const numeric = Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric > 1e12 ? numeric : numeric * 1000)
    : new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false });
};

export const formatVipText = (payload: unknown): string => {
  const items = findBusiVip(payload);
  const labels: Record<string, string> = { tvip: '畅听会员', svip: '概念会员' };
  const lines = items.flatMap((item) => {
    const type = String(item.product_type ?? '').toLowerCase();
    if (!labels[type]) return [];
    const active = Number(item.is_vip) === 1;
    const endTime = active ? formatEndTime(item.vip_end_time) : '';
    return [`${labels[type]}：${active ? '生效中' : '未生效'}${endTime ? `，到期 ${endTime}` : ''}`];
  });
  return lines.length > 0 ? lines.join('；') : '暂无畅听/概念会员记录';
};

export const isAlreadyClaimedResult = (result: KugouApiResult): boolean =>
  result.code === 131001 || /已领|已经领|重复领|领过/.test(result.message);

export const isAlreadyUpgradedResult = (result: KugouApiResult): boolean =>
  result.code === 297002 || /已经领取过升级|已升级|重复升级/.test(result.message);

export const isFutureDurationInsufficient = (result: KugouApiResult): boolean =>
  /未来.*时长不足|未来时长不足/.test(result.message);

const createResult = (
  patch: Partial<ClaimResult> & Pick<ClaimResult, 'ok' | 'message'>,
): ClaimResult => ({ claimed: false, alreadyClaimed: false, upgraded: false, ...patch });

interface ServiceDeps {
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
}

export const createVipService = (
  ctx: EchoPluginContext,
  state: PluginState,
  client: KugouClient,
  deps: ServiceDeps = {},
): VipService => {
  const now = deps.now ?? (() => new Date());
  let operationInFlight: Promise<ClaimResult> | null = null;
  let refreshInFlight: Promise<boolean> | null = null;
  let operationSettings: PluginSettings | null = null;
  let interruptWait: (() => void) | null = null;

  const getSettings = () => operationSettings ?? state.settings;

  const sleep = deps.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => {
    const timer = window.setTimeout(() => {
      interruptWait = null;
      resolve();
    }, milliseconds);
    interruptWait = () => {
      window.clearTimeout(timer);
      interruptWait = null;
      resolve();
    };
  }));

  const persist = async () => {
    await ctx.storage.set(STATE_KEY, state.persisted);
  };

  const setStatus = (kind: ClaimStatus['kind'], day: string, message: string) => {
    state.status = { kind, day, message, updatedAt: Date.now() };
  };

  const setProgress = (phase: PluginState['progress']['phase'], current: number, total: number, label: string) => {
    state.progress = { phase, current, total, label };
  };

  const addHistory = async (entry: Omit<HistoryEntry, 'id'>) => {
    state.persisted.history = [
      { ...entry, id: `${entry.startedAt}-${Math.random().toString(36).slice(2, 8)}` },
      ...state.persisted.history,
    ].slice(0, MAX_HISTORY);
    state.persisted.lastResult = entry.message;
    await persist();
  };

  const claimDates = async (
    options: RunOptions,
    scope: 'configured' | 'today' | 'future' | 'specified',
    specifiedDay = '',
  ): Promise<ClaimResult> => {
    client.getAuth();
    const today = formatChinaDay(now());
    const configuredDates = buildTargetDates(getSettings(), now());
    const dates = scope === 'today'
      ? [today]
      : scope === 'future'
        ? configuredDates.filter((day) => day !== today)
        : scope === 'specified'
          ? [specifiedDay]
        : configuredDates;
    if (dates.length === 0) {
      const message = '未配置未来预领日期';
      setStatus('idle', today, message);
      return createResult({ ok: true, message });
    }
    const targets = options.force
      ? dates
      : dates.filter((day) => !state.persisted.claimedDates[day]?.ok);
    if (targets.length === 0) {
      const message = '目标日期均已完成领取';
      setStatus('already-claimed', formatChinaDay(now()), message);
      return createResult({ ok: true, claimed: true, alreadyClaimed: true, message });
    }

    let claimed = 0;
    let already = 0;
    const failures: string[] = [];
    let insufficientDay = '';
    for (let index = 0; index < targets.length; index += 1) {
      if (state.cancelRequested) break;
      if (index > 0) await sleep(CLAIM_TASK_INTERVAL_MS);
      if (state.cancelRequested) break;
      const day = targets[index];
      setProgress('claim', index + 1, targets.length, `正在领取 ${day}`);
      setStatus('claiming', day, `正在领取 ${day}`);
      try {
        const result = await client.claimDayVip(day);
        if (result.ok || isAlreadyClaimedResult(result)) {
          const wasAlready = !result.ok;
          state.persisted.claimedDates[day] = {
            ok: true,
            already: wasAlready,
            message: wasAlready ? `${day} 已领取` : result.message,
            updatedAt: Date.now(),
          };
          if (wasAlready) already += 1;
          else claimed += 1;
          await persist();
          continue;
        }
        if (isFutureDurationInsufficient(result)) {
          insufficientDay = day;
          break;
        }
        failures.push(`${day}: ${result.message}`);
        if (result.code === 20018) break;
      } catch (error) {
        failures.push(`${day}: ${error instanceof Error ? error.message : '网络请求失败'}`);
        break;
      }
    }

    if (state.cancelRequested) {
      const message = `领取已取消，完成 ${claimed + already}/${targets.length} 天`;
      setStatus('canceled', formatChinaDay(now()), message);
      return createResult({ ok: false, claimed: claimed + already > 0, canceled: true, message });
    }
    const parts = [
      claimed ? `新领取 ${claimed} 天` : '',
      already ? `${already} 天已领取` : '',
      insufficientDay ? `已达当前可预领上限，停在 ${insufficientDay}` : '',
      failures.length && !insufficientDay ? `失败 ${failures.length} 天：${failures[0]}` : '',
    ].filter(Boolean);
    const message = parts.join('；') || '领取任务已完成';
    const limited = Boolean(insufficientDay);
    setStatus(
      limited
        ? 'limit'
        : failures.length
          ? (claimed + already > 0 ? 'partial' : 'error')
          : already && !claimed
            ? 'already-claimed'
            : 'claimed',
      today,
      message,
    );
    return createResult({
      ok: failures.length === 0,
      claimed: claimed + already > 0,
      alreadyClaimed: already > 0,
      limited,
      message,
    });
  };

  const runAdsInternal = async (options: RunOptions): Promise<ClaimResult> => {
    client.getAuth();
    const day = formatChinaDay(now());
    const settings = getSettings();
    const target = settings.adEnabled || options.includeAds
      ? settings.adCount
      : 0;
    if (target <= 0) return createResult({ ok: true, message: '广告任务未启用' });
    const previous = state.persisted.adTaskDates[day];
    let done = options.force ? 0 : Math.min(previous?.done ?? 0, target);
    if (done >= target) return createResult({ ok: true, message: `广告任务今日已完成 ${done} 次` });
    const startIndex = done;
    let lastMessage = '';
    for (let index = done; index < target; index += 1) {
      if (state.cancelRequested) break;
      if (index > startIndex) await sleep(AD_TASK_INTERVAL_MS);
      if (state.cancelRequested) break;
      setProgress('ad', index + 1, target, `正在执行广告任务 ${index + 1}/${target}`);
      setStatus('advertising', day, `正在执行广告任务 ${index + 1}/${target}`);
      try {
        const end = Date.now();
        const result = await client.reportAdPlay(end - 30_000, end);
        if (!result.ok) {
          lastMessage = result.message;
          break;
        }
        const data = asRecord(result.data);
        done = Math.max(done + 1, clampInteger(data?.done, 0, 8, done + 1));
        lastMessage = result.message;
        state.persisted.adTaskDates[day] = { done, message: lastMessage, updatedAt: Date.now() };
        await persist();
        if (Number(data?.remain) <= 0) break;
      } catch (error) {
        lastMessage = error instanceof Error ? error.message : '广告任务网络请求失败';
        break;
      }
    }
    const completed = done >= target;
    const message = state.cancelRequested
      ? `广告任务已取消，今日完成 ${done}/${target} 次`
      : completed
        ? `广告任务完成 ${done}/${target} 次`
        : `广告任务完成 ${done}/${target} 次${lastMessage ? `：${lastMessage}` : ''}`;
    setStatus(state.cancelRequested ? 'canceled' : completed ? 'claimed' : done > 0 ? 'partial' : 'error', day, message);
    return createResult({ ok: completed, claimed: false, canceled: state.cancelRequested, message });
  };

  const upgradeInternal = async (options: RunOptions): Promise<ClaimResult> => {
    client.getAuth();
    const day = formatChinaDay(now());
    if (!options.force && state.persisted.upgradeDates[day]?.ok) {
      const message = '会员今日已升级';
      setStatus('upgraded', day, message);
      return createResult({ ok: true, claimed: true, upgraded: true, message });
    }
    setProgress('upgrade', 1, 1, '正在升级会员');
    setStatus('upgrading', day, '正在升级会员');
    try {
      const result = await client.upgradeDayVip();
      if (result.ok || isAlreadyUpgradedResult(result)) {
        const message = result.ok ? result.message : '会员今日已升级';
        state.persisted.upgradeDates[day] = { ok: true, already: !result.ok, message, updatedAt: Date.now() };
        await persist();
        setStatus('upgraded', day, message);
        return createResult({ ok: true, claimed: true, alreadyClaimed: !result.ok, upgraded: true, message });
      }
      setStatus('error', day, result.message);
      return createResult({ ok: false, message: result.message });
    } catch (error) {
      const message = error instanceof Error ? error.message : '会员升级网络请求失败';
      setStatus('error', day, message);
      return createResult({ ok: false, message });
    }
  };

  const refresh = (options: RefreshOptions = {}): Promise<boolean> => {
    if (refreshInFlight) return refreshInFlight;
    state.refreshing = true;
    state.refreshMessage = '正在刷新状态';
    refreshInFlight = (async () => {
      const [record, vip] = await Promise.allSettled([
        client.getMonthVipRecord(),
        client.getUnionVip(),
      ]);
      const recordOk = record.status === 'fulfilled' && record.value.ok;
      const vipOk = vip.status === 'fulfilled' && vip.value.ok;
      if (vipOk) {
        state.vipDetail = vip.value.raw;
        state.vipText = formatVipText(vip.value.raw);
      } else {
        const message = vip.status === 'fulfilled'
          ? vip.value.message
          : vip.reason instanceof Error
            ? vip.reason.message
            : '查询失败';
        state.vipText = `会员状态查询失败：${message}`;
      }
      if (recordOk) {
        state.monthRecord = record.value.raw;
        let changed = false;
        for (const targetDay of buildTargetDates(state.settings, now())) {
          if (!hasClaimedDay(record.value.raw, targetDay)) continue;
          state.persisted.claimedDates[targetDay] = {
            ok: true,
            already: true,
            message: `${targetDay} 已领取`,
            updatedAt: Date.now(),
          };
          changed = true;
        }
        if (changed) await persist();
      }
      const recordError = record.status === 'fulfilled'
        ? record.value.message
        : record.reason instanceof Error
          ? record.reason.message
          : '领取记录查询失败';
      const vipError = vip.status === 'fulfilled'
        ? vip.value.message
        : vip.reason instanceof Error
          ? vip.reason.message
          : '会员状态查询失败';
      state.refreshedAt = Date.now();
      if (recordOk && vipOk) state.refreshMessage = '状态已更新';
      else if (recordOk) state.refreshMessage = `领取状态已更新；会员查询失败：${vipError}`;
      else if (vipOk) state.refreshMessage = `会员状态已更新；领取记录查询失败：${recordError}`;
      else state.refreshMessage = options.reportFailure === false ? '后台刷新失败' : `刷新失败：${recordError}`;
      return recordOk;
    })().finally(() => {
      state.refreshing = false;
      refreshInFlight = null;
    });
    return refreshInFlight;
  };

  const execute = (source: 'manual' | 'auto', operation: () => Promise<ClaimResult>) => {
    if (operationInFlight) return operationInFlight;
    state.running = true;
    state.cancelRequested = false;
    operationSettings = normalizeSettings({ ...state.settings });
    const startedAt = Date.now();
    operationInFlight = (async () => {
      let result: ClaimResult;
      try {
        result = await operation();
      } catch (error) {
        const message = error instanceof Error ? error.message : '任务执行失败';
        setStatus('error', formatChinaDay(now()), message);
        result = createResult({ ok: false, message });
      }
      const outcome: HistoryEntry['outcome'] = result.canceled
        ? 'canceled'
        : result.limited
          ? 'limit'
          : result.ok
            ? 'success'
            : result.claimed || result.upgraded
              ? 'partial'
              : 'failed';
      await addHistory({ source, startedAt, finishedAt: Date.now(), ok: result.ok, outcome, message: result.message });
      if (source === 'auto' && state.settings.notifySuccess) {
        ctx.toast[result.ok ? 'success' : 'warning'](result.message);
      }
      return result;
    })().finally(() => {
        state.running = false;
        state.cancelRequested = false;
        setProgress('idle', 0, 0, '');
        operationSettings = null;
        operationInFlight = null;
      });
    return operationInFlight;
  };

  const claimConfigured = (options: RunOptions = {}) =>
    execute(options.source ?? 'manual', () => claimDates(options, 'configured'));
  const claimToday = (options: RunOptions = {}) =>
    execute(options.source ?? 'manual', () => claimDates(options, 'today'));
  const claimFuture = (options: RunOptions = {}) =>
    execute(options.source ?? 'manual', () => claimDates(options, 'future'));
  const claimDate = (day: string, options: RunOptions = {}) =>
    execute(options.source ?? 'manual', async () => {
      const normalizedDay = day.trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedDay) || addDays(normalizedDay, 0) !== normalizedDay) {
        throw new Error('请选择有效的领取日期');
      }
      if (normalizedDay < formatChinaDay(now())) throw new Error('不能领取早于今天的日期');
      return claimDates(options, 'specified', normalizedDay);
    });
  const runAds = (options: RunOptions = {}) =>
    execute(options.source ?? 'manual', () => runAdsInternal({ ...options, includeAds: true }));
  const upgrade = (options: RunOptions = {}) =>
    execute(options.source ?? 'manual', () => upgradeInternal(options));
  const runAll = (options: RunOptions = {}) =>
    execute(options.source ?? 'manual', async () => {
      const settings = getSettings();
      const initialClaim = await claimDates(options, 'today');
      const messages = [initialClaim.message];
      let ok = initialClaim.ok;
      let claimed = initialClaim.claimed;
      let alreadyClaimed = initialClaim.alreadyClaimed;
      let upgraded = false;
      if (!initialClaim.ok && !initialClaim.claimed) return initialClaim;
      let limited = initialClaim.limited;
      if (!state.cancelRequested && (settings.autoUpgrade || options.includeUpgrade)) {
        const upgradeResult = await upgradeInternal(options);
        messages.push(upgradeResult.message);
        ok = ok && upgradeResult.ok;
        upgraded = upgradeResult.upgraded;
      }
      if (!state.cancelRequested && (settings.adEnabled || options.includeAds)) {
        const ads = await runAdsInternal(options);
        messages.push(ads.message);
        ok = ok && ads.ok;
      }
      if (!state.cancelRequested && settings.futureDays > 0) {
        const futureClaim = await claimDates(options, 'future');
        messages.push(futureClaim.message);
        ok = ok && futureClaim.ok;
        claimed = claimed || futureClaim.claimed;
        alreadyClaimed = alreadyClaimed || futureClaim.alreadyClaimed;
        limited = limited || futureClaim.limited;
      }
      const message = messages.filter(Boolean).join('；');
      if (state.cancelRequested) return createResult({ ok: false, claimed, upgraded, canceled: true, message });
      setStatus(limited ? 'limit' : ok ? (upgraded ? 'upgraded' : claimed ? 'claimed' : 'idle') : claimed ? 'partial' : 'error', formatChinaDay(now()), message);
      void refresh({ reportFailure: false });
      return createResult({ ok, claimed, alreadyClaimed, upgraded, limited, message });
    });

  return {
    runAll,
    claimConfigured,
    claimToday,
    claimFuture,
    claimDate,
    upgrade,
    runAds,
    refresh,
    cancel() {
      if (state.running) {
        state.cancelRequested = true;
        interruptWait?.();
      }
    },
  };
};
