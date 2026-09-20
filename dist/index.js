const SETTINGS_KEY = 'settings';
const STATUS_KEY = 'last-status';
const AUTO_UPGRADE_RETRY_MS = 21600000;
const DEFAULT_SETTINGS = Object.freeze({
    autoClaim: false,
    autoUpgrade: false,
    notifySuccess: true
});
const EMPTY_STATUS = Object.freeze({
    kind: 'idle',
    day: '',
    message: '尚未执行',
    updatedAt: 0
});
const asRecord = (value)=>null === value || 'object' != typeof value || Array.isArray(value) ? null : value;
const normalizeSettings = (value)=>{
    const source = asRecord(value);
    return {
        autoClaim: 'boolean' == typeof source?.autoClaim ? source.autoClaim : DEFAULT_SETTINGS.autoClaim,
        autoUpgrade: 'boolean' == typeof source?.autoUpgrade ? source.autoUpgrade : DEFAULT_SETTINGS.autoUpgrade,
        notifySuccess: 'boolean' == typeof source?.notifySuccess ? source.notifySuccess : DEFAULT_SETTINGS.notifySuccess
    };
};
const normalizeStatus = (value)=>{
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
        'error'
    ]);
    const kind = String(source?.kind ?? '');
    return {
        kind: validKinds.has(kind) ? kind : EMPTY_STATUS.kind,
        day: 'string' == typeof source?.day ? source.day : EMPTY_STATUS.day,
        message: 'string' == typeof source?.message ? source.message : EMPTY_STATUS.message,
        updatedAt: 'number' == typeof source?.updatedAt && Number.isFinite(source.updatedAt) ? source.updatedAt : EMPTY_STATUS.updatedAt
    };
};
const formatChinaDay = (date = new Date())=>{
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part)=>[
            part.type,
            part.value
        ]));
    return `${values.year}-${values.month}-${values.day}`;
};
const matchesDay = (value, day)=>{
    if ('number' == typeof value) return String(value) === day.replaceAll('-', '');
    if ('string' != typeof value) return false;
    const normalized = value.trim();
    return normalized === day || normalized === day.replaceAll('-', '') || normalized.startsWith(`${day}T`) || normalized.startsWith(`${day} `);
};
const CLAIM_DAY_KEYS = new Set([
    'receive_day',
    'received_day',
    'receive_date',
    'received_date',
    'claim_day',
    'claimed_day'
]);
const CLAIM_RECORD_KEYS = new Set([
    'data',
    'list',
    'records',
    'record_list',
    'days',
    'receive_days',
    'received_days',
    'vip_records'
]);
const hasClaimedDay = (payload, day)=>{
    const seen = new WeakSet();
    const visit = (value, depth, allowDateValue = false)=>{
        if (allowDateValue && matchesDay(value, day)) return true;
        if (depth > 10 || null === value || 'object' != typeof value) return false;
        if (seen.has(value)) return false;
        seen.add(value);
        if (Array.isArray(value)) return value.some((item)=>visit(item, depth + 1, allowDateValue));
        return Object.entries(value).some(([key, item])=>{
            const normalizedKey = key.toLowerCase();
            if (CLAIM_DAY_KEYS.has(normalizedKey)) return matchesDay(item, day);
            return visit(item, depth + 1, CLAIM_RECORD_KEYS.has(normalizedKey));
        });
    };
    return visit(payload, 0);
};
const findMessage = (value, depth = 0)=>{
    if (depth > 5) return '';
    if ('string' == typeof value) return value.trim();
    if (null === value || 'object' != typeof value) return '';
    const record = asRecord(value);
    if (record) {
        for (const key of [
            'msg',
            'message',
            'error',
            'errmsg',
            'error_msg'
        ]){
            const candidate = record[key];
            if ('string' == typeof candidate && candidate.trim()) return candidate.trim();
        }
        for (const candidate of Object.values(record)){
            const message = findMessage(candidate, depth + 1);
            if (message) return message;
        }
    }
    return '';
};
const getApiErrorCode = (payload)=>{
    for (const key of [
        'error_code',
        'err_code',
        'errcode'
    ]){
        const value = payload[key];
        if (null != value && '0' !== String(value)) return `${key}: ${String(value)}`;
    }
    return '';
};
const getErrorMessage = (error, fallback = '操作失败')=>{
    const record = asRecord(error);
    const response = asRecord(record?.response);
    const responseBody = asRecord(response?.body);
    const responseErrorCode = responseBody ? getApiErrorCode(responseBody) : '';
    return findMessage(response?.body) || (responseErrorCode ? `酷狗接口错误 (${responseErrorCode})` : '') || findMessage(record) || (error instanceof Error ? error.message : '') || fallback;
};
const assertApiSuccess = (payload, fallback)=>{
    const record = asRecord(payload);
    if (!record) throw new Error(fallback);
    const statusFailed = void 0 !== record.status && 1 !== Number(record.status);
    const successFailed = false === record.success;
    const errorCode = getApiErrorCode(record);
    if (statusFailed || successFailed || errorCode) {
        const detail = getApiMessage(payload, '');
        throw new Error(detail || (errorCode ? `${fallback} (${errorCode})` : fallback));
    }
    return payload;
};
const isAlreadyClaimedError = (error)=>/(已领取|领取过|重复领取|不可重复|already\s*(claimed|received))/i.test(getErrorMessage(error, ''));
const isAlreadyUpgradedError = (error)=>/(已升级|无需升级|重复升级|already\s*upgrad)/i.test(getErrorMessage(error, ''));
const getApiMessage = (payload, fallback)=>findMessage(payload) || fallback;
const createResult = (patch)=>({
        claimed: false,
        alreadyClaimed: false,
        upgraded: false,
        ...patch
    });
const saveStatus = async (ctx, state, status)=>{
    state.status = status;
    try {
        await ctx.storage.set(STATUS_KEY, status);
    } catch (error) {
        console.warn('[kugou-concept-vip] 保存状态失败', error);
    }
};
const createVipService = (ctx, state)=>{
    let operationInFlight = null;
    const updateStatus = (kind, day, message)=>saveStatus(ctx, state, {
            kind,
            day,
            message,
            updatedAt: Date.now()
        });
    const refresh = async (options = {})=>{
        state.refreshing = true;
        const day = formatChinaDay();
        try {
            const record = assertApiSuccess(await ctx.kugou.user.getVipMonthRecord(), '领取记录刷新失败');
            state.monthRecord = record;
            if (hasClaimedDay(record, day)) await updateStatus('already-claimed', day, `${day} 已领取`);
            else if (false !== options.reportFailure) await updateStatus('idle', day, '今日尚未领取');
            return true;
        } catch (error) {
            if (false !== options.reportFailure) await updateStatus('error', day, `状态刷新失败：领取记录：${getErrorMessage(error, '查询失败')}`);
            return false;
        } finally{
            state.refreshing = false;
        }
    };
    const runExclusive = (operation)=>{
        if (operationInFlight) return operationInFlight;
        operationInFlight = operation().finally(()=>{
            operationInFlight = null;
        });
        return operationInFlight;
    };
    const finishAlreadyUpgraded = async (day, source)=>{
        const message = '当前账号已是畅听会员';
        await updateStatus('upgraded', day, message);
        if ('manual' === source) ctx.toast.info(message);
        return createResult({
            ok: true,
            claimed: true,
            alreadyClaimed: true,
            upgraded: true,
            message
        });
    };
    const shouldDelayAutoUpgradeRetry = (day, previousStatus)=>previousStatus?.kind === 'partial' && previousStatus.day === day && Date.now() - previousStatus.updatedAt < AUTO_UPGRADE_RETRY_MS;
    const performUpgrade = async (day, source, knownClaimed, previousStatus = state.status)=>{
        if ('auto' === source && shouldDelayAutoUpgradeRetry(day, previousStatus)) {
            state.status = previousStatus;
            const message = previousStatus?.message || '升级稍后自动重试';
            return createResult({
                ok: true,
                claimed: true,
                message
            });
        }
        if (!knownClaimed && 'auto' === source) try {
            const record = assertApiSuccess(await ctx.kugou.user.getVipMonthRecord(), '领取记录查询失败');
            state.monthRecord = record;
            if (!hasClaimedDay(record, day)) {
                const message = '请先领取今日 VIP，再升级畅听会员';
                await updateStatus('idle', day, message);
                return createResult({
                    ok: false,
                    message
                });
            }
        } catch (error) {
            const message = `自动升级已跳过：${getErrorMessage(error, '无法确认领取记录')}`;
            await updateStatus('error', day, message);
            return createResult({
                ok: false,
                message
            });
        }
        if (previousStatus?.kind === 'upgraded' && previousStatus.day === day) return finishAlreadyUpgraded(day, source);
        await updateStatus('upgrading', day, '正在升级畅听会员');
        try {
            const response = assertApiSuccess(await ctx.kugou.user.upgradeDayVip(), '畅听会员升级失败');
            const message = getApiMessage(response, '已升级为畅听会员');
            await updateStatus('upgraded', day, message);
            if ('manual' === source || state.settings.notifySuccess) ctx.toast.success(message);
            refresh({
                reportFailure: false
            });
            return createResult({
                ok: true,
                claimed: true,
                upgraded: true,
                message
            });
        } catch (error) {
            if (isAlreadyUpgradedError(error)) return finishAlreadyUpgraded(day, source);
            const message = knownClaimed ? `VIP 已领取，但升级失败：${getErrorMessage(error)}` : `畅听会员升级失败：${getErrorMessage(error)}`;
            await updateStatus(knownClaimed ? 'partial' : 'error', day, message);
            if ('manual' === source || state.settings.notifySuccess) ctx.toast.warning(message);
            return createResult({
                ok: false,
                claimed: knownClaimed,
                message
            });
        }
    };
    const runClaim = async (options)=>{
        const source = options.source ?? 'manual';
        const day = formatChinaDay();
        const previousStatus = state.status;
        await updateStatus('checking', day, '正在检查领取记录');
        try {
            const record = assertApiSuccess(await ctx.kugou.user.getVipMonthRecord(), '领取记录查询失败');
            state.monthRecord = record;
            if (hasClaimedDay(record, day)) {
                if (state.settings.autoUpgrade) return performUpgrade(day, source, true, previousStatus);
                const message = `${day} 已领取`;
                await updateStatus('already-claimed', day, message);
                if ('manual' === source) ctx.toast.info(message);
                return createResult({
                    ok: true,
                    claimed: true,
                    alreadyClaimed: true,
                    message
                });
            }
        } catch (error) {
            if ('auto' === source) {
                const message = `自动领取已跳过：${getErrorMessage(error, '无法确认领取记录')}`;
                await updateStatus('error', day, message);
                return createResult({
                    ok: false,
                    message
                });
            }
        }
        await updateStatus('claiming', day, '正在领取当日 VIP');
        let claimResponse;
        try {
            claimResponse = assertApiSuccess(await ctx.kugou.user.claimDayVip(day), 'VIP 领取失败');
        } catch (error) {
            if (isAlreadyClaimedError(error)) {
                if (state.settings.autoUpgrade) return performUpgrade(day, source, true, previousStatus);
                const message = `${day} 已领取`;
                await updateStatus('already-claimed', day, message);
                if ('manual' === source) ctx.toast.info(message);
                return createResult({
                    ok: true,
                    claimed: true,
                    alreadyClaimed: true,
                    message
                });
            }
            const message = getErrorMessage(error, 'VIP 领取失败');
            await updateStatus('error', day, message);
            if ('manual' === source) ctx.toast.danger(message);
            return createResult({
                ok: false,
                message
            });
        }
        if (state.settings.autoUpgrade) return performUpgrade(day, source, true, null);
        const message = getApiMessage(claimResponse, '今日概念版 VIP 领取成功');
        await updateStatus('claimed', day, message);
        if ('manual' === source || state.settings.notifySuccess) ctx.toast.success(message);
        refresh({
            reportFailure: false
        });
        return createResult({
            ok: true,
            claimed: true,
            message
        });
    };
    const claimToday = (options = {})=>runExclusive(()=>runClaim(options));
    const upgrade = ()=>runExclusive(()=>performUpgrade(formatChinaDay(), 'manual', false));
    return {
        claimToday,
        upgrade,
        refresh
    };
};
const AUTO_CHECK_INTERVAL_MS = 1800000;
const INITIAL_AUTO_CHECK_DELAY_MS = 3000;
const statusLabel = (status)=>{
    const labels = {
        idle: '尚未执行',
        checking: '检查中',
        claiming: '领取中',
        upgrading: '升级中',
        claimed: '已领取',
        'already-claimed': '今日已领取',
        upgraded: '已升级',
        partial: '部分完成',
        error: '执行失败'
    };
    return labels[status.kind];
};
const INITIAL_DIALOG_STATUS = {
    ...EMPTY_STATUS,
    kind: 'checking',
    message: '正在刷新会员状态'
};
const getSettingsDialogCloseButton = (event)=>{
    const target = event.currentTarget;
    if (!(target instanceof Element)) return null;
    const dialog = target.closest('[role="dialog"]');
    return dialog?.querySelector('.dialog-close') ?? null;
};
const formatUpdatedAt = (timestamp)=>{
    if (!timestamp) return '--';
    return new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).format(new Date(timestamp));
};
const createSettingsComponent = (ctx, state, service)=>ctx.vue.defineComponent({
        name: 'KugouConceptVipSettings',
        setup () {
            const { computed, defineAsyncComponent, h, onMounted, reactive, ref } = ctx.vue;
            const Button = defineAsyncComponent(ctx.ui.components.Button);
            const Switch = defineAsyncComponent(ctx.ui.components.Switch);
            const draft = reactive(normalizeSettings(state.settings));
            const saving = ref(false);
            const action = ref('');
            const statusReady = ref(false);
            const visibleStatus = computed(()=>statusReady.value ? state.status : INITIAL_DIALOG_STATUS);
            const hasCurrentMonthRecord = computed(()=>statusReady.value && null !== state.monthRecord);
            const busy = computed(()=>'' !== action.value || 'checking' === state.status.kind || 'claiming' === state.status.kind || 'upgrading' === state.status.kind);
            onMounted(()=>{
                statusReady.value = false;
                action.value = 'refresh';
                service.refresh().finally(()=>{
                    statusReady.value = true;
                    action.value = '';
                });
            });
            const save = async (event)=>{
                if (saving.value) return;
                const closeButton = getSettingsDialogCloseButton(event);
                saving.value = true;
                try {
                    const settings = normalizeSettings({
                        ...draft
                    });
                    await ctx.storage.set(SETTINGS_KEY, settings);
                    state.settings = settings;
                    ctx.toast.success('设置已保存');
                    closeButton?.click();
                } catch (error) {
                    ctx.toast.danger(error instanceof Error ? error.message : '设置保存失败');
                } finally{
                    saving.value = false;
                }
            };
            const claim = async ()=>{
                if (busy.value) return;
                statusReady.value = true;
                action.value = 'claim';
                try {
                    await service.claimToday({
                        source: 'manual'
                    });
                } finally{
                    action.value = '';
                }
            };
            const upgrade = async ()=>{
                if (busy.value) return;
                statusReady.value = true;
                action.value = 'upgrade';
                try {
                    await service.upgrade();
                } finally{
                    action.value = '';
                }
            };
            const refresh = async ()=>{
                if (busy.value) return;
                statusReady.value = false;
                action.value = 'refresh';
                try {
                    const ok = await service.refresh();
                    statusReady.value = true;
                    ctx.toast[ok ? 'success' : 'warning'](ok ? '会员状态已刷新' : state.status.message || '状态刷新失败');
                } finally{
                    statusReady.value = true;
                    action.value = '';
                }
            };
            const switchRow = (label, key, disabled = false)=>h('label', {
                    class: 'echo-vip-switch-row'
                }, [
                    h('span', label),
                    h(Switch, {
                        modelValue: draft[key],
                        disabled,
                        'onUpdate:modelValue': (value)=>{
                            draft[key] = Boolean(value);
                        }
                    })
                ]);
            const button = (label, props)=>h(Button, props, {
                    default: ()=>label
                });
            return ()=>h('div', {
                    class: 'echo-vip-settings'
                }, [
                    h('section', {
                        class: 'echo-vip-status'
                    }, [
                        h('div', {
                            class: 'echo-vip-status-main'
                        }, [
                            h('span', {
                                class: `echo-vip-state is-${visibleStatus.value.kind}`
                            }, statusLabel(visibleStatus.value)),
                            h('strong', visibleStatus.value.message || '尚未执行')
                        ]),
                        h('dl', {
                            class: 'echo-vip-meta'
                        }, [
                            h('div', [
                                h('dt', '领取日期'),
                                h('dd', visibleStatus.value.day || '--')
                            ]),
                            h('div', [
                                h('dt', '更新时间'),
                                h('dd', formatUpdatedAt(visibleStatus.value.updatedAt))
                            ]),
                            h('div', [
                                h('dt', '本月记录'),
                                h('dd', hasCurrentMonthRecord.value ? '已获取' : '未获取')
                            ])
                        ])
                    ]),
                    h('section', {
                        class: 'echo-vip-actions'
                    }, [
                        button('claim' === action.value ? '领取中...' : '领取今日 VIP', {
                            variant: 'primary',
                            size: 'sm',
                            loading: 'claim' === action.value,
                            disabled: busy.value,
                            onClick: claim
                        }),
                        button('upgrade' === action.value ? '升级中...' : '升级畅听会员', {
                            variant: 'outline',
                            size: 'sm',
                            loading: 'upgrade' === action.value,
                            disabled: busy.value,
                            onClick: upgrade
                        }),
                        button('refresh' === action.value ? '刷新中...' : '刷新状态', {
                            variant: 'ghost',
                            size: 'sm',
                            loading: 'refresh' === action.value,
                            disabled: busy.value,
                            onClick: refresh
                        })
                    ]),
                    h('section', {
                        class: 'echo-vip-options'
                    }, [
                        switchRow('启动后自动领取', 'autoClaim'),
                        switchRow('领取后自动升级', 'autoUpgrade'),
                        switchRow('自动领取成功时通知', 'notifySuccess', !draft.autoClaim)
                    ]),
                    h('div', {
                        class: 'echo-vip-footer'
                    }, [
                        button(saving.value ? '保存中...' : '保存设置', {
                            variant: 'primary',
                            size: 'sm',
                            loading: saving.value,
                            disabled: saving.value,
                            onClick: save
                        })
                    ])
                ]);
        }
    });
async function activate(ctx) {
    const [savedSettings, savedStatus] = await Promise.all([
        ctx.storage.get(SETTINGS_KEY),
        ctx.storage.get(STATUS_KEY)
    ]);
    const state = ctx.vue.reactive({
        settings: normalizeSettings(savedSettings),
        status: normalizeStatus(savedStatus),
        monthRecord: null,
        vipDetail: null,
        refreshing: false
    });
    const service = createVipService(ctx, state);
    ctx.ui.settings.define({
        title: '酷狗概念版 VIP',
        component: createSettingsComponent(ctx, state, service)
    });
    ctx.ui.titlebar.register({
        id: 'claim-today',
        title: '领取今日 VIP',
        tooltip: '领取酷狗概念版今日 VIP',
        icon: 'tabler:gift',
        defaultPlacement: 'more',
        order: 300,
        disabled: ()=>'checking' === state.status.kind || 'claiming' === state.status.kind || 'upgrading' === state.status.kind,
        onClick: ()=>service.claimToday({
                source: 'manual'
            })
    });
    const runAutoClaim = ()=>{
        if (!state.settings.autoClaim) return;
        service.claimToday({
            source: 'auto'
        });
    };
    const startupTimer = window.setTimeout(runAutoClaim, INITIAL_AUTO_CHECK_DELAY_MS);
    const intervalTimer = window.setInterval(runAutoClaim, AUTO_CHECK_INTERVAL_MS);
    ctx.dispose(()=>{
        window.clearTimeout(startupTimer);
        window.clearInterval(intervalTimer);
    });
}
function deactivate() {}
export { DEFAULT_SETTINGS, activate, deactivate, formatChinaDay, hasClaimedDay };
