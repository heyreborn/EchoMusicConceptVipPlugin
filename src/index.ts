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
  PluginSettings,
  PluginState,
  VipService,
} from './types';

const AUTO_CHECK_INTERVAL_MS = 30 * 60 * 1000;

const statusLabel = (status: ClaimStatus): string => {
  const labels: Record<ClaimStatus['kind'], string> = {
    idle: '尚未执行',
    checking: '检查中',
    claiming: '领取中',
    advertising: '广告任务',
    upgrading: '升级中',
    claimed: '已领取',
    'already-claimed': '今日已领取',
    upgraded: '已升级',
    partial: '部分完成',
    canceled: '已取消',
    error: '执行失败',
  };
  return labels[status.kind];
};

const INITIAL_DIALOG_STATUS: ClaimStatus = {
  ...EMPTY_STATUS,
  kind: 'checking',
  message: '正在刷新会员状态',
};

const getSettingsDialogCloseButton = (event: Event): HTMLButtonElement | null => {
  const target = event.currentTarget;
  if (!(target instanceof Element)) return null;
  return target.closest('[role="dialog"]')?.querySelector<HTMLButtonElement>('.dialog-close') ?? null;
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
      const saving = ref(false);
      const statusReady = ref(false);
      const visibleStatus = computed(() =>
        statusReady.value ? state.status : INITIAL_DIALOG_STATUS,
      );

      onMounted(() => {
        statusReady.value = false;
        void service.refresh().finally(() => {
          statusReady.value = true;
        });
      });

      const run = async (operation: () => Promise<unknown>) => {
        statusReady.value = true;
        await operation();
      };

      const save = async (event: Event) => {
        if (saving.value) return;
        const closeButton = getSettingsDialogCloseButton(event);
        saving.value = true;
        try {
          const settings = normalizeSettings({ ...draft });
          await ctx.storage.set(SETTINGS_KEY, settings);
          state.settings = settings;
          scheduleStartup();
          ctx.toast.success('设置已保存');
          closeButton?.click();
        } catch (error) {
          ctx.toast.danger(error instanceof Error ? error.message : '设置保存失败');
        } finally {
          saving.value = false;
        }
      };

      const clearHistory = async () => {
        state.persisted.history = [];
        state.persisted.lastResult = '';
        await ctx.storage.set(STATE_KEY, state.persisted);
        ctx.toast.success('执行记录已清除');
      };

      const button = (label: string, props: Record<string, unknown>) =>
        h(Button, props, { default: () => label });

      type BooleanSetting = 'autoClaim' | 'autoUpgrade' | 'notifySuccess' | 'adEnabled';
      const switchRow = (label: string, description: string, key: BooleanSetting) =>
        h('label', { class: 'echo-vip-setting-row' }, [
          h('span', { class: 'echo-vip-setting-copy' }, [
            h('strong', label),
            h('small', description),
          ]),
          h(Switch, {
            modelValue: draft[key],
            'onUpdate:modelValue': (value: unknown) => {
              draft[key] = Boolean(value);
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
          h('span', { class: 'echo-vip-setting-copy' }, [
            h('strong', label),
            h('small', description),
          ]),
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
            },
          }),
        ]);

      return () =>
        h('div', { class: 'echo-vip-settings' }, [
          h('section', { class: 'echo-vip-status' }, [
            h('div', { class: 'echo-vip-status-main' }, [
              h(
                'span',
                { class: `echo-vip-state is-${visibleStatus.value.kind}` },
                statusLabel(visibleStatus.value),
              ),
              h('strong', visibleStatus.value.message),
            ]),
            state.running
              ? h('div', { class: 'echo-vip-progress' }, [
                  h('span', state.progress.label || '任务执行中'),
                  h('span', `${state.progress.current}/${state.progress.total}`),
                ])
              : null,
            h('dl', { class: 'echo-vip-meta' }, [
              h('div', [h('dt', '中国日期'), h('dd', formatChinaDay())]),
              h('div', [h('dt', '更新时间'), h('dd', formatTime(visibleStatus.value.updatedAt))]),
              h('div', [h('dt', '领取记录'), h('dd', state.monthRecord ? '已获取' : '未获取')]),
            ]),
            h('p', { class: 'echo-vip-member-status' }, state.vipText),
          ]),

          h('section', { class: 'echo-vip-actions' }, [
            button(state.running ? '执行中...' : '执行全部任务', {
              variant: 'primary',
              size: 'sm',
              loading: state.running,
              disabled: state.running,
              onClick: () => run(() => service.runAll({ source: 'manual', force: true })),
            }),
            button('只领取', {
              variant: 'outline',
              size: 'sm',
              disabled: state.running,
              onClick: () => run(() => service.claimConfigured({ source: 'manual', force: true })),
            }),
            button('只升级', {
              variant: 'outline',
              size: 'sm',
              disabled: state.running,
              onClick: () => run(() => service.upgrade({ source: 'manual', force: true })),
            }),
            button('广告任务', {
              variant: 'outline',
              size: 'sm',
              disabled: state.running || !draft.adEnabled,
              onClick: () => run(() => service.runAds({ source: 'manual', force: true })),
            }),
            button('刷新状态', {
              variant: 'ghost',
              size: 'sm',
              disabled: state.running,
              onClick: () => run(() => service.refresh()),
            }),
            state.running
              ? button('取消', { variant: 'ghost', size: 'sm', onClick: () => service.cancel() })
              : null,
          ]),

          h('section', { class: 'echo-vip-options' }, [
            switchRow('启动后自动执行', '先领取今天，再升级、执行广告并领取未来日期', 'autoClaim'),
            sliderRow('未来领取天数', '0 表示只领取今天，7 表示今天及未来七天', 'futureDays', 7, ' 天'),
            sliderRow('启动延迟', '等待 EchoMusic 登录态和设备信息加载', 'delaySeconds', 60, ' 秒'),
            switchRow('领取后自动升级', '领取今天后先增加概念会员时长，再尝试未来日期', 'autoUpgrade'),
            switchRow('模拟广告任务', '实验性功能，通过酷狗网关提交广告完成记录', 'adEnabled'),
            sliderRow('每日广告次数', '每次间隔约 35 秒，每日最多 8 次', 'adCount', 8, ' 次', !draft.adEnabled),
            switchRow('自动任务结果通知', '自动执行结束后显示应用内通知', 'notifySuccess'),
            h('label', { class: 'echo-vip-setting-row' }, [
              h('span', { class: 'echo-vip-setting-copy' }, [
                h('strong', '指定领取日期'),
                h('small', '使用 auto 按日期序列领取，或输入 YYYY-MM-DD'),
              ]),
              h(Input, {
                class: 'echo-vip-date-input',
                modelValue: draft.receiveDay,
                placeholder: 'auto',
                'onUpdate:modelValue': (value: unknown) => {
                  draft.receiveDay = String(value ?? '').trim() || 'auto';
                },
              }),
            ]),
          ]),

          state.persisted.history.length
            ? h('section', { class: 'echo-vip-history' }, [
                h('div', { class: 'echo-vip-history-header' }, [
                  h('strong', '最近执行记录'),
                  button('清除', { variant: 'ghost', size: 'xs', onClick: clearHistory }),
                ]),
                ...state.persisted.history.slice(0, 6).map((entry) =>
                  h('div', { class: 'echo-vip-history-row', key: entry.id }, [
                    h('time', formatTime(entry.finishedAt)),
                    h('span', entry.ok ? '成功' : '未完成'),
                    h('p', entry.message),
                  ]),
                ),
              ])
            : null,

          h('div', { class: 'echo-vip-footer' }, [
            button(saving.value ? '保存中...' : '保存设置', {
              variant: 'primary',
              size: 'sm',
              loading: saving.value,
              disabled: saving.value,
              onClick: save,
            }),
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
      void service.runAll({ source: 'auto' });
    }, state.settings.delaySeconds * 1000);
  };

  scheduleStartup();
  const intervalTimer = window.setInterval(() => {
    if (state.settings.autoClaim) void service.runAll({ source: 'auto' });
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
    disabled: () => state.running,
    onClick: () => service.claimToday({ source: 'manual', force: true }),
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
