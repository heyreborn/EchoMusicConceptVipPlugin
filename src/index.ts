import {
  RETRY_DELAYS_MS,
  SETTINGS_KEY,
  STATE_KEY,
  createVipService,
  formatChinaDay,
  nextChinaDailyRunAt,
  normalizePersistedState,
  normalizeSettings,
} from './core';
import { createKugouClient } from './kugou';
import type { EchoPluginContext, PluginSettings, PluginState } from './types';

const SETTINGS_SAVE_DELAY_MS = 350;

const createSettingsComponent = (
  ctx: EchoPluginContext,
  state: PluginState,
  onSettingsSaved: (previous: PluginSettings, next: PluginSettings) => void,
) =>
  ctx.vue.defineComponent({
    name: 'KugouConceptVipSettings',
    setup() {
      const { defineAsyncComponent, h, reactive, ref } = ctx.vue;
      const Switch = defineAsyncComponent(ctx.ui.components.Switch);
      const Slider = defineAsyncComponent(ctx.ui.components.Slider);
      const draft = reactive<PluginSettings>(normalizeSettings(state.settings));
      const saveStatus = ref<'idle' | 'saving' | 'saved' | 'error'>('idle');
      const savedAt = ref(0);
      let saveTimer = 0;
      let saveRevision = 0;
      let saveQueue = Promise.resolve();
      let lastSaved = normalizeSettings(state.settings);

      const formatTime = (timestamp: number) =>
        timestamp
          ? new Intl.DateTimeFormat('zh-CN', {
              timeZone: 'Asia/Shanghai',
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
              hour12: false,
            }).format(new Date(timestamp))
          : '';

      const commitSettings = (revision: number) => {
        window.clearTimeout(saveTimer);
        const next = normalizeSettings({ ...draft });
        state.settings = next;
        const save = async () => {
          const previous = lastSaved;
          try {
            await ctx.storage.set(SETTINGS_KEY, next);
            lastSaved = next;
            onSettingsSaved(previous, next);
            if (revision === saveRevision) {
              state.settings = next;
              savedAt.value = Date.now();
              saveStatus.value = 'saved';
            }
          } catch (error) {
            if (revision === saveRevision) {
              Object.assign(draft, lastSaved);
              state.settings = lastSaved;
              saveStatus.value = 'error';
              ctx.toast.danger(error instanceof Error ? error.message : '设置自动保存失败');
            }
          }
        };
        saveQueue = saveQueue.then(save, save);
      };

      const queueSettingsSave = (delay = SETTINGS_SAVE_DELAY_MS) => {
        window.clearTimeout(saveTimer);
        const revision = ++saveRevision;
        state.settings = normalizeSettings({ ...draft });
        saveStatus.value = 'saving';
        saveTimer = window.setTimeout(() => commitSettings(revision), delay);
      };

      type BooleanSetting = 'autoClaim' | 'autoUpgrade' | 'notifySuccess' | 'adEnabled';
      const switchRow = (label: string, description: string, key: BooleanSetting) =>
        h('label', { class: 'echo-vip-setting-row' }, [
          h('span', { class: 'echo-vip-setting-copy' }, [h('strong', label), h('small', description)]),
          h(Switch, {
            modelValue: draft[key],
            'onUpdate:modelValue': (value: unknown) => {
              draft[key] = Boolean(value);
              queueSettingsSave(0);
            },
          }),
        ]);

      const sliderRow = (
        label: string,
        description: string,
        key: 'futureDays' | 'delaySeconds' | 'adCount',
        maximum: number,
        suffix: string,
        disabled = false,
      ) =>
        h('div', { class: `echo-vip-slider-row${disabled ? ' is-disabled' : ''}` }, [
          h('span', { class: 'echo-vip-setting-copy' }, [h('strong', label), h('small', description)]),
          h(Slider, {
            modelValue: draft[key],
            min: 0,
            max: maximum,
            step: 1,
            showValue: true,
            valueSuffix: suffix,
            disabled,
            'onUpdate:modelValue': (value: unknown) => {
              draft[key] = Number(value);
              queueSettingsSave();
            },
          }),
        ]);

      return () =>
        h('div', { class: 'echo-vip-settings' }, [
          h('section', { class: 'echo-vip-options' }, [
            h('div', { class: 'echo-vip-section-heading' }, [
              h('h3', '自动任务'),
              h('p', 'EchoMusic 启动后执行，并在保持运行时于北京时间每天 09:00 执行。'),
            ]),
            switchRow('启用自动任务', '关闭后取消尚未开始的任务和失败重试', 'autoClaim'),
            sliderRow('启动延迟', '默认等待 60 秒，确保酷狗登录态和设备信息已加载', 'delaySeconds', 60, ' 秒'),
            switchRow('每日自动升级', '领取今日 VIP 后增加概念会员时长', 'autoUpgrade'),
            switchRow('自动执行广告任务', '每次约 35 秒，8 次约需 4 至 5 分钟', 'adEnabled'),
            sliderRow('每日广告次数', '每天最多 8 次，酷狗提示次数用光时自动视为完成', 'adCount', 8, ' 次', !draft.adEnabled),
            sliderRow('最多预领未来天数', '达到会员可预领上限后，当天不再重复请求', 'futureDays', 7, ' 天'),
            switchRow('任务结果通知', '获得新权益、达到预领上限或执行失败时通知', 'notifySuccess'),
          ]),
          h('footer', { class: `echo-vip-save-state is-${saveStatus.value}` }, [
            saveStatus.value === 'saving'
              ? '正在自动保存...'
              : saveStatus.value === 'saved'
                ? `已自动保存 ${formatTime(savedAt.value)}`
                : saveStatus.value === 'error'
                  ? '自动保存失败，请重试'
                  : '设置修改后自动保存',
          ]),
        ]);
    },
  });

export async function activate(ctx: EchoPluginContext) {
  const [savedSettings, savedState] = await Promise.all([
    ctx.storage.get(SETTINGS_KEY),
    ctx.storage.get(STATE_KEY),
  ]);
  const state = ctx.vue.reactive<PluginState>({
    settings: normalizeSettings(savedSettings),
    persisted: normalizePersistedState(savedState),
    running: false,
    cancelRequested: false,
  });
  const service = createVipService(ctx, state, createKugouClient(ctx));
  let pendingRunTimer = 0;
  let dailyTimer = 0;
  let retryTimer = 0;
  let pendingRunIgnoresCompletion = false;

  const persistState = () => ctx.storage.set(STATE_KEY, state.persisted);
  const clearPendingRun = () => {
    window.clearTimeout(pendingRunTimer);
    pendingRunTimer = 0;
  };
  const clearRetry = () => {
    window.clearTimeout(retryTimer);
    retryTimer = 0;
  };

  const scheduleRetry = async (day: string, message: string) => {
    if (state.persisted.retryDay !== day) {
      state.persisted.retryDay = day;
      state.persisted.retryCount = 0;
    }
    const retryIndex = state.persisted.retryCount;
    if (retryIndex >= RETRY_DELAYS_MS.length) {
      await persistState();
      if (state.settings.notifySuccess) ctx.toast.danger(`酷狗 VIP 自动任务失败：${message}`);
      return;
    }
    const delay = RETRY_DELAYS_MS[retryIndex];
    state.persisted.retryCount += 1;
    await persistState();
    clearRetry();
    retryTimer = window.setTimeout(() => {
      retryTimer = 0;
      void runAutomatic(true);
    }, delay);
    if (state.settings.notifySuccess) {
      ctx.toast.warning(`酷狗 VIP 自动任务暂未完成，将在 ${delay / 60_000} 分钟后重试`);
    }
  };

  const runAutomatic = async (ignoreCompleted = false) => {
    if (!state.settings.autoClaim || state.running) return;
    const day = formatChinaDay();
    if (!ignoreCompleted && state.persisted.autoRunDates[day]?.ok) return;
    const result = await service.runAll();
    if (result.canceled || !state.settings.autoClaim) return;
    if (result.ok) {
      state.persisted.autoRunDates[day] = {
        ok: true,
        message: result.message,
        updatedAt: Date.now(),
      };
      state.persisted.retryDay = day;
      state.persisted.retryCount = 0;
      clearRetry();
      await persistState();
      if (state.settings.notifySuccess) {
        if (result.changed) ctx.toast.success(`酷狗 VIP 自动任务：${result.message}`);
        else if (result.limited) ctx.toast.info(`酷狗 VIP 自动任务：${result.message}`);
      }
      return;
    }
    if (result.retryable) {
      await scheduleRetry(day, result.message);
    } else if (state.settings.notifySuccess) {
      ctx.toast.danger(`酷狗 VIP 自动任务失败：${result.message}`);
    }
  };

  const scheduleRun = (delaySeconds: number, ignoreCompleted: boolean) => {
    clearPendingRun();
    if (!state.settings.autoClaim) return;
    pendingRunIgnoresCompletion = ignoreCompleted;
    pendingRunTimer = window.setTimeout(() => {
      pendingRunTimer = 0;
      void runAutomatic(pendingRunIgnoresCompletion);
    }, Math.max(0, delaySeconds) * 1000);
  };

  const scheduleDaily = () => {
    window.clearTimeout(dailyTimer);
    const delay = Math.max(1_000, nextChinaDailyRunAt().getTime() - Date.now());
    dailyTimer = window.setTimeout(() => {
      void runAutomatic(false).finally(scheduleDaily);
    }, delay);
  };

  const onSettingsSaved = (previous: PluginSettings, next: PluginSettings) => {
    const taskChanged =
      previous.autoUpgrade !== next.autoUpgrade ||
      previous.adEnabled !== next.adEnabled ||
      previous.adCount !== next.adCount ||
      previous.futureDays !== next.futureDays;
    if (!next.autoClaim) {
      clearPendingRun();
      clearRetry();
      service.cancel();
      return;
    }
    if (!previous.autoClaim || taskChanged) {
      clearRetry();
      const day = formatChinaDay();
      delete state.persisted.autoRunDates[day];
      void persistState();
      scheduleRun(next.delaySeconds, true);
      return;
    }
    if (previous.delaySeconds !== next.delaySeconds && pendingRunTimer) {
      scheduleRun(next.delaySeconds, pendingRunIgnoresCompletion);
    }
  };

  if (state.settings.autoClaim) scheduleRun(state.settings.delaySeconds, false);
  scheduleDaily();

  ctx.ui.settings.define({
    title: '酷狗概念版 VIP',
    component: createSettingsComponent(ctx, state, onSettingsSaved),
  });

  ctx.dispose(() => {
    service.cancel();
    clearPendingRun();
    clearRetry();
    window.clearTimeout(dailyTimer);
  });
}

export function deactivate() {}

export { DEFAULT_SETTINGS, buildTargetDates, formatChinaDay, nextChinaDailyRunAt } from './core';
export { getEchoKugouAuth, md5, parseKugouResult, signAndroidLite } from './kugou';
