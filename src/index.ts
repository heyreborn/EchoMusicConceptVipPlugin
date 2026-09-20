import {
  EMPTY_STATUS,
  SETTINGS_KEY,
  STATE_KEY,
  createVipService,
  formatChinaDay,
  normalizePersistedState,
  normalizeSettings,
} from './core';
import { createKugouClient } from './kugou';
import type {
  ClaimStatus,
  EchoPluginContext,
  HistoryEntry,
  PluginSettings,
  PluginState,
  VipService,
} from './types';

const AUTO_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const SETTINGS_SAVE_DELAY_MS = 350;

const statusLabel = (status: ClaimStatus): string => {
  const labels: Record<ClaimStatus['kind'], string> = {
    idle: '等待执行',
    checking: '检查中',
    claiming: '领取中',
    advertising: '广告任务',
    upgrading: '升级中',
    claimed: '领取完成',
    'already-claimed': '已领取',
    upgraded: '升级完成',
    limit: '已达上限',
    partial: '部分完成',
    canceled: '已取消',
    error: '执行失败',
  };
  return labels[status.kind];
};

const historyLabel = (entry: HistoryEntry): string => {
  const outcome = entry.outcome ?? (entry.ok ? 'success' : 'failed');
  return {
    success: '完成',
    limit: '已达上限',
    partial: '部分完成',
    canceled: '已取消',
    failed: '失败',
  }[outcome];
};

const formatTime = (timestamp: number): string => {
  if (!timestamp) return '--';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(timestamp));
};

const createSettingsComponent = (
  ctx: EchoPluginContext,
  state: PluginState,
  service: VipService,
  scheduleStartup: () => void,
) =>
  ctx.vue.defineComponent({
    name: 'KugouConceptVipSettings',
    setup() {
      const { computed, defineAsyncComponent, h, onMounted, reactive, ref } = ctx.vue;
      const Button = defineAsyncComponent(ctx.ui.components.Button);
      const Switch = defineAsyncComponent(ctx.ui.components.Switch);
      const Slider = defineAsyncComponent(ctx.ui.components.Slider);
      const Input = defineAsyncComponent(ctx.ui.components.Input);
      const draft = reactive<PluginSettings>(normalizeSettings(state.settings));
      const specifiedDay = ref(formatChinaDay());
      const saveStatus = ref<'idle' | 'saving' | 'saved' | 'error'>('idle');
      const savedAt = ref(0);
      let saveTimer = 0;
      let saveRevision = 0;
      let saveQueue = Promise.resolve();
      let lastSaved = normalizeSettings(state.settings);

      const busy = computed(() => state.running || state.refreshing);
      const today = computed(() => formatChinaDay());
      const todayClaimed = computed(() => Boolean(state.persisted.claimedDates[today.value]?.ok));
      const todayUpgraded = computed(() => Boolean(state.persisted.upgradeDates[today.value]?.ok));
      const adDone = computed(() => state.persisted.adTaskDates[today.value]?.done ?? 0);
      const latestFutureDay = computed(() =>
        Object.entries(state.persisted.claimedDates)
          .filter(([day, record]) => day > today.value && record.ok)
          .map(([day]) => day)
          .sort()
          .at(-1) ?? '',
      );
      const enabledSteps = computed(() => {
        const steps = ['今日领取'];
        if (draft.autoUpgrade) steps.push('每日升级');
        if (draft.adEnabled && draft.adCount > 0) steps.push(`广告 ${draft.adCount} 次`);
        if (draft.futureDays > 0) steps.push(`最多预领 ${draft.futureDays} 天`);
        return steps.join('、');
      });
      const progressHint = computed(() => {
        if (state.progress.phase !== 'ad' || state.progress.total <= state.progress.current) return '';
        const minutes = Math.max(1, Math.ceil(((state.progress.total - state.progress.current) * 35) / 60));
        return `预计还需约 ${minutes} 分钟`;
      });

      const commitSettings = (revision: number) => {
        window.clearTimeout(saveTimer);
        const next = normalizeSettings({ ...draft });
        state.settings = next;
        saveStatus.value = 'saving';
        const save = async () => {
          try {
            await ctx.storage.set(SETTINGS_KEY, next);
            lastSaved = next;
            if (revision === saveRevision) {
              state.settings = next;
              scheduleStartup();
              savedAt.value = Date.now();
              saveStatus.value = 'saved';
            }
          } catch (error) {
            if (revision === saveRevision) {
              Object.assign(draft, lastSaved);
              state.settings = lastSaved;
              scheduleStartup();
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

      onMounted(() => {
        state.status = { ...EMPTY_STATUS };
        void service.refresh();
      });

      const run = async (operation: () => Promise<unknown>) => {
        if (busy.value) return;
        try {
          await operation();
        } catch (error) {
          ctx.toast.danger(error instanceof Error ? error.message : '操作失败');
        }
      };

      const clearHistory = async () => {
        state.persisted.history = [];
        state.persisted.lastResult = '';
        await ctx.storage.set(STATE_KEY, state.persisted);
      };

      const button = (label: string, props: Record<string, unknown>) =>
        h(Button, props, { default: () => label });

      const statusRow = (label: string, value: string, tone: string) =>
        h('div', { class: 'echo-vip-summary-row' }, [
          h('span', label),
          h('strong', { class: `is-${tone}` }, value),
        ]);

      type BooleanSetting = 'autoClaim' | 'autoUpgrade' | 'notifySuccess' | 'adEnabled';
      const switchRow = (label: string, description: string, key: BooleanSetting, disabled = false) =>
        h('label', { class: `echo-vip-setting-row${disabled ? ' is-disabled' : ''}` }, [
          h('span', { class: 'echo-vip-setting-copy' }, [h('strong', label), h('small', description)]),
          h(Switch, {
            modelValue: draft[key],
            disabled: disabled || state.running,
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
            disabled: disabled || state.running,
            'onUpdate:modelValue': (value: unknown) => {
              draft[key] = Number(value);
              queueSettingsSave();
            },
          }),
        ]);

      return () =>
        h('div', { class: 'echo-vip-settings' }, [
          h('section', { class: 'echo-vip-overview' }, [
            h('div', { class: 'echo-vip-section-heading' }, [
              h('div', [h('h3', '今日任务'), h('p', state.refreshMessage || '尚未刷新状态')]),
              button(state.refreshing ? '刷新中...' : '刷新', {
                variant: 'ghost',
                size: 'sm',
                loading: state.refreshing,
                disabled: busy.value,
                title: '刷新领取记录和会员状态',
                onClick: () => run(() => service.refresh()),
              }),
            ]),
            h('div', { class: 'echo-vip-summary' }, [
              statusRow('今日 VIP', state.refreshing && !todayClaimed.value ? '查询中' : todayClaimed.value ? '已领取' : '尚未领取', todayClaimed.value ? 'success' : 'muted'),
              statusRow('每日升级', todayUpgraded.value ? '已完成' : draft.autoUpgrade ? '待执行' : '未启用', todayUpgraded.value ? 'success' : 'muted'),
              statusRow('广告任务', draft.adEnabled ? `${adDone.value}/${draft.adCount}` : '未启用', adDone.value >= draft.adCount && draft.adCount > 0 ? 'success' : 'muted'),
              statusRow('未来预领', latestFutureDay.value ? `已领取至 ${latestFutureDay.value}` : '尚未预领', latestFutureDay.value ? 'success' : 'muted'),
            ]),
            h('p', { class: 'echo-vip-member-status' }, state.vipText),
            h('div', { class: 'echo-vip-refresh-meta' }, [
              h('span', state.refreshedAt ? `更新于 ${formatTime(state.refreshedAt)}` : '等待首次刷新'),
              h('span', `中国日期 ${today.value}`),
            ]),
          ]),

          state.running || state.status.updatedAt
            ? h('section', { class: `echo-vip-task-state is-${state.status.kind}` }, [
                h('div', { class: 'echo-vip-task-state-line' }, [
                  h('span', { class: `echo-vip-state is-${state.status.kind}` }, statusLabel(state.status)),
                  h('strong', state.status.message),
                ]),
                state.running
                  ? h('div', { class: 'echo-vip-progress' }, [
                      h('span', state.progress.label || '任务执行中'),
                      h('span', `${state.progress.current}/${state.progress.total}${progressHint.value ? ` · ${progressHint.value}` : ''}`),
                    ])
                  : null,
              ])
            : null,

          h('section', { class: 'echo-vip-primary-actions' }, [
            button(state.running ? '执行中...' : '执行今日任务', {
              variant: 'primary',
              size: 'sm',
              loading: state.running,
              disabled: busy.value,
              onClick: () => run(() => service.runAll({ source: 'manual' })),
            }),
            state.running
              ? button('取消任务', { variant: 'outline', size: 'sm', onClick: () => service.cancel() })
              : null,
            h('p', `将执行：${enabledSteps.value}`),
          ]),

          h('details', { class: 'echo-vip-more' }, [
            h('summary', '更多操作'),
            h('div', { class: 'echo-vip-more-content' }, [
              h('div', { class: 'echo-vip-secondary-actions' }, [
                button('仅领取今日', { variant: 'outline', size: 'sm', disabled: busy.value, onClick: () => run(() => service.claimToday({ source: 'manual' })) }),
                button('补领未来日期', { variant: 'outline', size: 'sm', disabled: busy.value || draft.futureDays === 0, onClick: () => run(() => service.claimFuture({ source: 'manual' })) }),
                button('仅执行升级', { variant: 'outline', size: 'sm', disabled: busy.value, onClick: () => run(() => service.upgrade({ source: 'manual' })) }),
                button('仅执行广告', { variant: 'outline', size: 'sm', disabled: busy.value || draft.adCount === 0, onClick: () => run(() => service.runAds({ source: 'manual' })) }),
              ]),
              h('div', { class: 'echo-vip-specified-date' }, [
                h('span', { class: 'echo-vip-setting-copy' }, [h('strong', '领取指定日期'), h('small', '一次性操作，不影响自动任务设置')]),
                h('div', [
                  h(Input, {
                    class: 'echo-vip-date-input',
                    type: 'date',
                    min: today.value,
                    modelValue: specifiedDay.value,
                    disabled: busy.value,
                    'onUpdate:modelValue': (value: unknown) => {
                      specifiedDay.value = String(value ?? '');
                    },
                  }),
                  button('领取', {
                    variant: 'outline',
                    size: 'sm',
                    disabled: busy.value || !specifiedDay.value,
                    onClick: () => run(() => service.claimDate(specifiedDay.value, { source: 'manual' })),
                  }),
                ]),
              ]),
            ]),
          ]),

          h('section', { class: 'echo-vip-options' }, [
            h('div', { class: 'echo-vip-section-heading' }, [h('div', [h('h3', '自动任务'), h('p', '设置修改后自动保存')])]),
            switchRow('启动后自动执行', 'EchoMusic 启动并等待登录状态准备完成后执行', 'autoClaim'),
            sliderRow('启动延迟', '默认等待 60 秒，避免登录态和设备信息尚未加载', 'delaySeconds', 60, ' 秒', !draft.autoClaim),
            switchRow('自动执行每日升级', '领取今日 VIP 后增加概念会员时长', 'autoUpgrade'),
            switchRow('自动执行广告任务', '每次约 35 秒，8 次约需 4 至 5 分钟', 'adEnabled'),
            sliderRow('每日广告次数', '每天最多 8 次，每次增加的时长由酷狗返回为准', 'adCount', 8, ' 次', !draft.adEnabled),
            sliderRow('最多预领未来天数', '实际天数取决于会员剩余时长，达到上限后自动停止', 'futureDays', 7, ' 天'),
            switchRow('任务结果通知', '自动任务结束后显示应用内通知', 'notifySuccess'),
          ]),

          state.persisted.history.length
            ? h('section', { class: 'echo-vip-history' }, [
                h('div', { class: 'echo-vip-history-header' }, [
                  h('div', [h('h3', '最近执行记录'), h('p', '保留最近 20 次任务')]),
                  button('清除', { variant: 'ghost', size: 'xs', disabled: busy.value, onClick: clearHistory }),
                ]),
                ...state.persisted.history.slice(0, 8).map((entry) => {
                  const outcome = entry.outcome ?? (entry.ok ? 'success' : 'failed');
                  return h('div', { class: 'echo-vip-history-row', key: entry.id }, [
                    h('time', formatTime(entry.finishedAt)),
                    h('span', { class: `is-${outcome}` }, historyLabel(entry)),
                    h('p', entry.message),
                  ]);
                }),
              ])
            : null,

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
    status: { ...EMPTY_STATUS },
    monthRecord: null,
    vipDetail: null,
    vipText: '尚未查询会员状态',
    running: false,
    refreshing: false,
    refreshMessage: '尚未刷新状态',
    refreshedAt: 0,
    cancelRequested: false,
    progress: { phase: 'idle', current: 0, total: 0, label: '' },
  });
  const client = createKugouClient(ctx);
  const service = createVipService(ctx, state, client);
  let startupTimer = 0;
  const scheduleStartup = () => {
    window.clearTimeout(startupTimer);
    if (!state.settings.autoClaim) return;
    startupTimer = window.setTimeout(() => {
      if (!state.refreshing) void service.runAll({ source: 'auto' });
    }, state.settings.delaySeconds * 1000);
  };

  scheduleStartup();
  const intervalTimer = window.setInterval(() => {
    if (state.settings.autoClaim && !state.refreshing) void service.runAll({ source: 'auto' });
  }, AUTO_CHECK_INTERVAL_MS);

  ctx.ui.settings.define({
    title: '酷狗概念版 VIP',
    component: createSettingsComponent(ctx, state, service, scheduleStartup),
  });

  ctx.ui.titlebar.register({
    id: 'claim-today',
    title: '领取今日 VIP',
    tooltip: '直连酷狗领取今日 VIP',
    icon: 'tabler:gift',
    defaultPlacement: 'more',
    order: 300,
    disabled: () => state.running || state.refreshing,
    onClick: () => service.claimToday({ source: 'manual' }),
  });

  ctx.dispose(() => {
    service.cancel();
    window.clearTimeout(startupTimer);
    window.clearInterval(intervalTimer);
  });
}

export function deactivate() {}

export { DEFAULT_SETTINGS, buildTargetDates, formatChinaDay, hasClaimedDay } from './core';
export { getEchoKugouAuth, md5, parseKugouResult, signAndroidLite } from './kugou';
