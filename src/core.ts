import type {
  ClaimResult,
  EchoPluginContext,
  KugouApiResult,
  KugouClient,
  PersistedState,
  PluginSettings,
  PluginState,
  VipService,
} from './types';

export const SETTINGS_KEY = 'settings-v2';
export const STATE_KEY = 'state-v3';
export const AD_TASK_INTERVAL_MS = 35_000;
export const CLAIM_TASK_INTERVAL_MS = 1_200;
export const DAILY_RUN_HOUR = 9;
export const DAILY_RUN_MINUTE = 0;
export const RETRY_DELAYS_MS = [10 * 60_000, 30 * 60_000, 60 * 60_000] as const;

export const DEFAULT_SETTINGS: Readonly<PluginSettings> = Object.freeze({
  autoClaim: false,
  autoUpgrade: false,
  notifySuccess: true,
  futureDays: 7,
  delaySeconds: 60,
  adEnabled: false,
  adCount: 8,
});

export const EMPTY_PERSISTED_STATE: Readonly<PersistedState> = Object.freeze({
  claimedDates: {},
  upgradeDates: {},
  adTaskDates: {},
  futureLimits: {},
  autoRunDates: {},
  retryDay: '',
  retryCount: 0,
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
    autoUpgrade: typeof source?.autoUpgrade === 'boolean' ? source.autoUpgrade : DEFAULT_SETTINGS.autoUpgrade,
    notifySuccess: typeof source?.notifySuccess === 'boolean' ? source.notifySuccess : DEFAULT_SETTINGS.notifySuccess,
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
    futureLimits: (asRecord(source?.futureLimits) ?? {}) as PersistedState['futureLimits'],
    autoRunDates: (asRecord(source?.autoRunDates) ?? {}) as PersistedState['autoRunDates'],
    retryDay: typeof source?.retryDay === 'string' ? source.retryDay : '',
    retryCount: clampInteger(source?.retryCount, 0, RETRY_DELAYS_MS.length, 0),
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

export const nextChinaDailyRunAt = (now = new Date()): Date => {
  const today = formatChinaDay(now);
  const time = `${String(DAILY_RUN_HOUR).padStart(2, '0')}:${String(DAILY_RUN_MINUTE).padStart(2, '0')}:00+08:00`;
  const todayRun = new Date(`${today}T${time}`);
  return todayRun.getTime() > now.getTime()
    ? todayRun
    : new Date(`${addDays(today, 1)}T${time}`);
};

export const isAlreadyClaimedResult = (result: KugouApiResult): boolean =>
  result.code === 131001 || /已领|已经领|重复领|领过/.test(result.message);

export const isAlreadyUpgradedResult = (result: KugouApiResult): boolean =>
  result.code === 297002 || /已经领取过升级|已升级|重复升级/.test(result.message);

export const isFutureDurationInsufficient = (result: KugouApiResult): boolean =>
  /未来.*时长不足|未来时长不足/.test(result.message);

export const isAdLimitResult = (result: KugouApiResult): boolean =>
  /今天.*次数.*用光|今日.*次数.*用光|广告.*次数.*上限|已达.*广告.*上限/.test(result.message);

const isRetryableResult = (result: KugouApiResult): boolean =>
  result.code === 20018 || /登录.*过期|未登录|网络|超时|timeout|HTTP 5\d\d/i.test(result.message);

const createResult = (
  patch: Partial<ClaimResult> & Pick<ClaimResult, 'ok' | 'message'>,
): ClaimResult => ({ changed: false, ...patch });

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

  const persist = () => ctx.storage.set(STATE_KEY, state.persisted);

  const clearFutureLimit = async (day: string) => {
    if (!state.persisted.futureLimits[day]) return;
    delete state.persisted.futureLimits[day];
    await persist();
  };

  const claimDates = async (scope: 'today' | 'future'): Promise<ClaimResult> => {
    client.getAuth();
    const today = formatChinaDay(now());
    const dates = buildTargetDates(getSettings(), now());
    const selected = scope === 'today' ? [today] : dates.filter((day) => day !== today);
    if (selected.length === 0) return createResult({ ok: true, message: '未配置未来预领日期' });

    const cachedLimit = scope === 'future' ? state.persisted.futureLimits[today] : undefined;
    if (cachedLimit) {
      return createResult({
        ok: true,
        limited: true,
        message: `已达当前可预领上限，停在 ${cachedLimit.blockedDay}`,
      });
    }

    const targets = selected.filter((day) => !state.persisted.claimedDates[day]?.ok);
    if (targets.length === 0) {
      return createResult({ ok: true, message: scope === 'today' ? '今日 VIP 已领取' : '未来目标日期均已领取' });
    }

    let claimed = 0;
    let already = 0;
    let limitedDay = '';
    let failure = '';
    let retryable = false;
    for (let index = 0; index < targets.length; index += 1) {
      if (state.cancelRequested) break;
      if (index > 0) await sleep(CLAIM_TASK_INTERVAL_MS);
      if (state.cancelRequested) break;
      const day = targets[index];
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
        if (scope === 'future' && isFutureDurationInsufficient(result)) {
          limitedDay = day;
          state.persisted.futureLimits[today] = {
            blockedDay: day,
            message: result.message,
            updatedAt: Date.now(),
          };
          await persist();
          break;
        }
        failure = `${day}: ${result.message}`;
        retryable = isRetryableResult(result);
        break;
      } catch (error) {
        failure = `${day}: ${error instanceof Error ? error.message : '网络请求失败'}`;
        retryable = true;
        break;
      }
    }

    if (state.cancelRequested) {
      return createResult({ ok: false, changed: claimed > 0, canceled: true, message: '任务已取消' });
    }
    if (failure) {
      return createResult({
        ok: false,
        changed: claimed > 0,
        retryable,
        message: `VIP 领取失败：${failure}`,
      });
    }
    if (limitedDay) {
      return createResult({
        ok: true,
        changed: claimed > 0,
        limited: true,
        message: `${claimed ? `新领取 ${claimed} 天；` : ''}已达当前可预领上限，停在 ${limitedDay}`,
      });
    }
    if (scope === 'future') await clearFutureLimit(today);
    const parts = [claimed ? `新领取 ${claimed} 天` : '', already ? `${already} 天已领取` : ''].filter(Boolean);
    return createResult({ ok: true, changed: claimed > 0, message: parts.join('；') || 'VIP 领取已完成' });
  };

  const upgrade = async (): Promise<ClaimResult> => {
    client.getAuth();
    const day = formatChinaDay(now());
    if (state.persisted.upgradeDates[day]?.ok) {
      return createResult({ ok: true, message: '会员今日已升级' });
    }
    try {
      const result = await client.upgradeDayVip();
      if (result.ok || isAlreadyUpgradedResult(result)) {
        const changed = result.ok;
        state.persisted.upgradeDates[day] = {
          ok: true,
          already: !result.ok,
          message: changed ? result.message : '会员今日已升级',
          updatedAt: Date.now(),
        };
        if (changed) delete state.persisted.futureLimits[day];
        await persist();
        return createResult({ ok: true, changed, message: changed ? '会员升级成功' : '会员今日已升级' });
      }
      return createResult({
        ok: false,
        retryable: isRetryableResult(result),
        message: `会员升级失败：${result.message}`,
      });
    } catch (error) {
      return createResult({
        ok: false,
        retryable: true,
        message: `会员升级失败：${error instanceof Error ? error.message : '网络请求失败'}`,
      });
    }
  };

  const runAds = async (): Promise<ClaimResult> => {
    client.getAuth();
    const day = formatChinaDay(now());
    const target = getSettings().adCount;
    if (target <= 0) return createResult({ ok: true, message: '广告任务未配置次数' });
    const previous = state.persisted.adTaskDates[day];
    let done = Math.min(previous?.done ?? 0, target);
    if (done >= target) return createResult({ ok: true, message: `广告任务今日已完成 ${done}/${target}` });

    const startDone = done;
    let lastMessage = '';
    let retryable = false;
    let exhausted = false;
    while (done < target && !state.cancelRequested) {
      if (done > startDone) await sleep(AD_TASK_INTERVAL_MS);
      if (state.cancelRequested) break;
      try {
        const end = Date.now();
        const result = await client.reportAdPlay(end - 30_000, end);
        if (isAdLimitResult(result)) {
          done = target;
          lastMessage = result.message;
          exhausted = true;
          break;
        }
        if (!result.ok) {
          lastMessage = result.message;
          retryable = isRetryableResult(result);
          break;
        }
        const data = asRecord(result.data);
        const serverDone = clampInteger(data?.done, 0, 8, done + 1);
        done = Math.max(done + 1, serverDone);
        if (Number(data?.remain) <= 0) done = target;
        lastMessage = result.message;
        state.persisted.adTaskDates[day] = { done, message: lastMessage, updatedAt: Date.now() };
        delete state.persisted.futureLimits[day];
        await persist();
      } catch (error) {
        lastMessage = error instanceof Error ? error.message : '网络请求失败';
        retryable = true;
        break;
      }
    }

    if (done !== (previous?.done ?? 0)) {
      state.persisted.adTaskDates[day] = { done, message: lastMessage, updatedAt: Date.now() };
      await persist();
    }
    if (state.cancelRequested) {
      return createResult({ ok: false, changed: done > startDone, canceled: true, message: `广告任务已取消，完成 ${done}/${target}` });
    }
    if (done >= target) {
      return createResult({
        ok: true,
        changed: done > startDone && !exhausted,
        message: `广告任务今日已完成 ${done}/${target}`,
      });
    }
    return createResult({
      ok: false,
      changed: done > startDone,
      retryable,
      message: `广告任务完成 ${done}/${target}：${lastMessage || '执行失败'}`,
    });
  };

  const execute = () => {
    if (operationInFlight) return operationInFlight;
    state.running = true;
    state.cancelRequested = false;
    operationSettings = normalizeSettings({ ...state.settings });
    operationInFlight = (async () => {
      try {
        const results: ClaimResult[] = [];
        const today = await claimDates('today');
        results.push(today);
        if (!today.ok || today.canceled || today.retryable) return today;

        if (getSettings().autoUpgrade) {
          const upgradeResult = await upgrade();
          results.push(upgradeResult);
          if (upgradeResult.canceled || upgradeResult.retryable) return upgradeResult;
        }
        if (getSettings().adEnabled) {
          const adResult = await runAds();
          results.push(adResult);
          if (adResult.canceled || adResult.retryable) return adResult;
        }
        if (getSettings().futureDays > 0) results.push(await claimDates('future'));

        return createResult({
          ok: results.every((result) => result.ok),
          changed: results.some((result) => result.changed),
          limited: results.some((result) => result.limited),
          retryable: results.some((result) => result.retryable),
          canceled: results.some((result) => result.canceled),
          message: results.map((result) => result.message).filter(Boolean).join('；'),
        });
      } catch (error) {
        return createResult({
          ok: false,
          retryable: true,
          message: error instanceof Error ? error.message : '自动任务执行失败',
        });
      }
    })().finally(() => {
      state.running = false;
      state.cancelRequested = false;
      operationSettings = null;
      operationInFlight = null;
    });
    return operationInFlight;
  };

  return {
    runAll: execute,
    cancel() {
      if (!state.running) return;
      state.cancelRequested = true;
      interruptWait?.();
    },
  };
};
