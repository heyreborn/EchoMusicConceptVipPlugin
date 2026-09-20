import {
  SETTINGS_KEY,
  STATUS_KEY,
  createVipService,
  normalizeSettings,
  normalizeStatus,
} from './core';
import type {
  EchoPluginContext,
  PluginSettings,
  PluginState,
  VipService,
} from './types';

const AUTO_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const INITIAL_AUTO_CHECK_DELAY_MS = 3000;

const statusLabel = (state: PluginState): string => {
  const labels: Record<PluginState['status']['kind'], string> = {
    idle: '尚未执行',
    checking: '检查中',
    claiming: '领取中',
    upgrading: '升级中',
    claimed: '已领取',
    'already-claimed': '今日已领取',
    upgraded: '已升级',
    partial: '部分完成',
    error: '执行失败',
  };
  return labels[state.status.kind];
};

const formatUpdatedAt = (timestamp: number): string => {
  if (!timestamp) return '--';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
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
) =>
  ctx.vue.defineComponent({
    name: 'KugouConceptVipSettings',
    setup() {
      const { computed, defineAsyncComponent, h, onMounted, reactive, ref } = ctx.vue;
      const Button = defineAsyncComponent(ctx.ui.components.Button);
      const Switch = defineAsyncComponent(ctx.ui.components.Switch);
      type Action = 'claim' | 'upgrade' | 'refresh' | '';
      const draft = reactive<PluginSettings>(normalizeSettings(state.settings));
      const saving = ref(false);
      const action = ref<Action>('');
      const busy = computed(
        () =>
          action.value !== '' ||
          state.status.kind === 'checking' ||
          state.status.kind === 'claiming' ||
          state.status.kind === 'upgrading',
      );

      onMounted(() => {
        action.value = 'refresh';
        void service.refresh().finally(() => {
          action.value = '';
        });
      });

      const save = async () => {
        if (saving.value) return;
        saving.value = true;
        try {
          const settings = normalizeSettings({ ...draft });
          await ctx.storage.set(SETTINGS_KEY, settings);
          state.settings = settings;
          ctx.toast.success('设置已保存');
        } catch (error) {
          ctx.toast.danger(error instanceof Error ? error.message : '设置保存失败');
        } finally {
          saving.value = false;
        }
      };

      const claim = async () => {
        if (busy.value) return;
        action.value = 'claim';
        try {
          await service.claimToday({ source: 'manual' });
        } finally {
          action.value = '';
        }
      };

      const upgrade = async () => {
        if (busy.value) return;
        action.value = 'upgrade';
        try {
          await service.upgrade();
        } finally {
          action.value = '';
        }
      };

      const refresh = async () => {
        if (busy.value) return;
        action.value = 'refresh';
        try {
          const ok = await service.refresh();
          ctx.toast[ok ? 'success' : 'warning'](ok ? '会员状态已刷新' : '状态刷新失败');
        } finally {
          action.value = '';
        }
      };

      const switchRow = (
        label: string,
        key: keyof typeof draft,
        disabled = false,
      ) =>
        h('label', { class: 'echo-vip-switch-row' }, [
          h('span', label),
          h(Switch, {
            modelValue: draft[key],
            disabled,
            'onUpdate:modelValue': (value: unknown) => {
              draft[key] = Boolean(value);
            },
          }),
        ]);

      const button = (label: string, props: Record<string, unknown>) =>
        h(Button, props, { default: () => label });

      return () =>
        h('div', { class: 'echo-vip-settings' }, [
          h('section', { class: 'echo-vip-status' }, [
            h('div', { class: 'echo-vip-status-main' }, [
              h('span', { class: `echo-vip-state is-${state.status.kind}` }, statusLabel(state)),
              h('strong', state.status.message || '尚未执行'),
            ]),
            h('dl', { class: 'echo-vip-meta' }, [
              h('div', [h('dt', '领取日期'), h('dd', state.status.day || '--')]),
              h('div', [h('dt', '更新时间'), h('dd', formatUpdatedAt(state.status.updatedAt))]),
              h('div', [
                h('dt', '本月记录'),
                h('dd', state.monthRecord ? '已获取' : '未获取'),
              ]),
            ]),
          ]),
          h('section', { class: 'echo-vip-actions' }, [
            button(action.value === 'claim' ? '领取中...' : '领取今日 VIP', {
              variant: 'primary',
              size: 'sm',
              loading: action.value === 'claim',
              disabled: busy.value,
              onClick: claim,
            }),
            button(action.value === 'upgrade' ? '升级中...' : '升级畅听会员', {
              variant: 'outline',
              size: 'sm',
              loading: action.value === 'upgrade',
              disabled: busy.value,
              onClick: upgrade,
            }),
            button(action.value === 'refresh' ? '刷新中...' : '刷新状态', {
              variant: 'ghost',
              size: 'sm',
              loading: action.value === 'refresh',
              disabled: busy.value,
              onClick: refresh,
            }),
          ]),
          h('section', { class: 'echo-vip-options' }, [
            switchRow('启动后自动领取', 'autoClaim'),
            switchRow('领取后自动升级', 'autoUpgrade'),
            switchRow('自动领取成功时通知', 'notifySuccess', !draft.autoClaim),
          ]),
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
  const [savedSettings, savedStatus] = await Promise.all([
    ctx.storage.get(SETTINGS_KEY),
    ctx.storage.get(STATUS_KEY),
  ]);
  const state = ctx.vue.reactive<PluginState>({
    settings: normalizeSettings(savedSettings),
    status: normalizeStatus(savedStatus),
    monthRecord: null,
    vipDetail: null,
    refreshing: false,
  });
  const service = createVipService(ctx, state);

  ctx.ui.settings.define({
    title: '酷狗概念版 VIP',
    component: createSettingsComponent(ctx, state, service),
  });

  ctx.ui.titlebar.register({
    id: 'claim-today',
    title: '领取今日 VIP',
    tooltip: '领取酷狗概念版今日 VIP',
    icon: 'tabler:gift',
    defaultPlacement: 'more',
    order: 300,
    disabled: () =>
      state.status.kind === 'checking' ||
      state.status.kind === 'claiming' ||
      state.status.kind === 'upgrading',
    onClick: () => service.claimToday({ source: 'manual' }),
  });

  const runAutoClaim = () => {
    if (!state.settings.autoClaim) return;
    void service.claimToday({ source: 'auto' });
  };
  const startupTimer = window.setTimeout(runAutoClaim, INITIAL_AUTO_CHECK_DELAY_MS);
  const intervalTimer = window.setInterval(runAutoClaim, AUTO_CHECK_INTERVAL_MS);
  ctx.dispose(() => {
    window.clearTimeout(startupTimer);
    window.clearInterval(intervalTimer);
  });
}

export function deactivate() {}

export { DEFAULT_SETTINGS, formatChinaDay, hasClaimedDay } from './core';
