const SETTINGS_KEY = 'settings-v2';
const STATE_KEY = 'state-v3';
const AD_TASK_INTERVAL_MS = 35000;
const CLAIM_TASK_INTERVAL_MS = 1200;
const DAILY_RUN_HOUR = 9;
const DAILY_RUN_MINUTE = 0;
const RETRY_DELAYS_MS = [
    600000,
    1800000,
    3600000
];
const DEFAULT_SETTINGS = Object.freeze({
    autoClaim: false,
    autoUpgrade: false,
    notifySuccess: true,
    futureDays: 7,
    delaySeconds: 60,
    adEnabled: false,
    adCount: 8
});
Object.freeze({
    claimedDates: {},
    upgradeDates: {},
    adTaskDates: {},
    futureLimits: {},
    autoRunDates: {},
    retryDay: '',
    retryCount: 0
});
const asRecord = (value)=>null === value || 'object' != typeof value || Array.isArray(value) ? null : value;
const clampInteger = (value, minimum, maximum, fallback)=>{
    const parsed = Math.round(Number(value));
    return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
};
const normalizeSettings = (value)=>{
    const source = asRecord(value);
    return {
        autoClaim: 'boolean' == typeof source?.autoClaim ? source.autoClaim : DEFAULT_SETTINGS.autoClaim,
        autoUpgrade: 'boolean' == typeof source?.autoUpgrade ? source.autoUpgrade : DEFAULT_SETTINGS.autoUpgrade,
        notifySuccess: 'boolean' == typeof source?.notifySuccess ? source.notifySuccess : DEFAULT_SETTINGS.notifySuccess,
        futureDays: clampInteger(source?.futureDays, 0, 7, DEFAULT_SETTINGS.futureDays),
        delaySeconds: clampInteger(source?.delaySeconds, 0, 60, DEFAULT_SETTINGS.delaySeconds),
        adEnabled: 'boolean' == typeof source?.adEnabled ? source.adEnabled : DEFAULT_SETTINGS.adEnabled,
        adCount: clampInteger(source?.adCount, 0, 8, DEFAULT_SETTINGS.adCount)
    };
};
const normalizePersistedState = (value)=>{
    const source = asRecord(value);
    return {
        claimedDates: asRecord(source?.claimedDates) ?? {},
        upgradeDates: asRecord(source?.upgradeDates) ?? {},
        adTaskDates: asRecord(source?.adTaskDates) ?? {},
        futureLimits: asRecord(source?.futureLimits) ?? {},
        autoRunDates: asRecord(source?.autoRunDates) ?? {},
        retryDay: 'string' == typeof source?.retryDay ? source.retryDay : '',
        retryCount: clampInteger(source?.retryCount, 0, RETRY_DELAYS_MS.length, 0)
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
const addDays = (day, amount)=>{
    const [year, month, date] = day.split('-').map(Number);
    const next = new Date(Date.UTC(year, month - 1, date + amount, 12));
    return next.toISOString().slice(0, 10);
};
const buildTargetDates = (settings, now = new Date())=>{
    const today = formatChinaDay(now);
    return Array.from({
        length: settings.futureDays + 1
    }, (_, index)=>addDays(today, index));
};
const nextChinaDailyRunAt = (now = new Date())=>{
    const today = formatChinaDay(now);
    const time = `${String(DAILY_RUN_HOUR).padStart(2, '0')}:${String(DAILY_RUN_MINUTE).padStart(2, '0')}:00+08:00`;
    const todayRun = new Date(`${today}T${time}`);
    return todayRun.getTime() > now.getTime() ? todayRun : new Date(`${addDays(today, 1)}T${time}`);
};
const isAlreadyClaimedResult = (result)=>131001 === result.code || /已领|已经领|重复领|领过/.test(result.message);
const isAlreadyUpgradedResult = (result)=>297002 === result.code || /已经领取过升级|已升级|重复升级/.test(result.message);
const isFutureDurationInsufficient = (result)=>/未来.*时长不足|未来时长不足/.test(result.message);
const isAdLimitResult = (result)=>/今天.*次数.*用光|今日.*次数.*用光|广告.*次数.*上限|已达.*广告.*上限/.test(result.message);
const isRetryableResult = (result)=>20018 === result.code || /登录.*过期|未登录|网络|超时|timeout|HTTP 5\d\d/i.test(result.message);
const createResult = (patch)=>({
        changed: false,
        ...patch
    });
const createVipService = (ctx, state, client, deps = {})=>{
    const now = deps.now ?? (()=>new Date());
    let operationInFlight = null;
    let operationSettings = null;
    let interruptWait = null;
    const getSettings = ()=>operationSettings ?? state.settings;
    const sleep = deps.sleep ?? ((milliseconds)=>new Promise((resolve)=>{
            const timer = window.setTimeout(()=>{
                interruptWait = null;
                resolve();
            }, milliseconds);
            interruptWait = ()=>{
                window.clearTimeout(timer);
                interruptWait = null;
                resolve();
            };
        }));
    const persist = ()=>ctx.storage.set(STATE_KEY, state.persisted);
    const clearFutureLimit = async (day)=>{
        if (!state.persisted.futureLimits[day]) return;
        delete state.persisted.futureLimits[day];
        await persist();
    };
    const claimDates = async (scope)=>{
        client.getAuth();
        const today = formatChinaDay(now());
        const dates = buildTargetDates(getSettings(), now());
        const selected = 'today' === scope ? [
            today
        ] : dates.filter((day)=>day !== today);
        if (0 === selected.length) return createResult({
            ok: true,
            message: '未配置未来预领日期'
        });
        const cachedLimit = 'future' === scope ? state.persisted.futureLimits[today] : void 0;
        if (cachedLimit) return createResult({
            ok: true,
            limited: true,
            message: `已达当前可预领上限，停在 ${cachedLimit.blockedDay}`
        });
        const targets = selected.filter((day)=>!state.persisted.claimedDates[day]?.ok);
        if (0 === targets.length) return createResult({
            ok: true,
            message: 'today' === scope ? '今日 VIP 已领取' : '未来目标日期均已领取'
        });
        let claimed = 0;
        let already = 0;
        let limitedDay = '';
        let failure = '';
        let retryable = false;
        for(let index = 0; index < targets.length; index += 1){
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
                        updatedAt: Date.now()
                    };
                    if (wasAlready) already += 1;
                    else claimed += 1;
                    await persist();
                    continue;
                }
                if ('future' === scope && isFutureDurationInsufficient(result)) {
                    limitedDay = day;
                    state.persisted.futureLimits[today] = {
                        blockedDay: day,
                        message: result.message,
                        updatedAt: Date.now()
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
        if (state.cancelRequested) return createResult({
            ok: false,
            changed: claimed > 0,
            canceled: true,
            message: '任务已取消'
        });
        if (failure) return createResult({
            ok: false,
            changed: claimed > 0,
            retryable,
            message: `VIP 领取失败：${failure}`
        });
        if (limitedDay) return createResult({
            ok: true,
            changed: claimed > 0,
            limited: true,
            message: `${claimed ? `新领取 ${claimed} 天；` : ''}已达当前可预领上限，停在 ${limitedDay}`
        });
        if ('future' === scope) await clearFutureLimit(today);
        const parts = [
            claimed ? `新领取 ${claimed} 天` : '',
            already ? `${already} 天已领取` : ''
        ].filter(Boolean);
        return createResult({
            ok: true,
            changed: claimed > 0,
            message: parts.join('；') || 'VIP 领取已完成'
        });
    };
    const upgrade = async ()=>{
        client.getAuth();
        const day = formatChinaDay(now());
        if (state.persisted.upgradeDates[day]?.ok) return createResult({
            ok: true,
            message: '会员今日已升级'
        });
        try {
            const result = await client.upgradeDayVip();
            if (result.ok || isAlreadyUpgradedResult(result)) {
                const changed = result.ok;
                state.persisted.upgradeDates[day] = {
                    ok: true,
                    already: !result.ok,
                    message: changed ? result.message : '会员今日已升级',
                    updatedAt: Date.now()
                };
                if (changed) delete state.persisted.futureLimits[day];
                await persist();
                return createResult({
                    ok: true,
                    changed,
                    message: changed ? '会员升级成功' : '会员今日已升级'
                });
            }
            return createResult({
                ok: false,
                retryable: isRetryableResult(result),
                message: `会员升级失败：${result.message}`
            });
        } catch (error) {
            return createResult({
                ok: false,
                retryable: true,
                message: `会员升级失败：${error instanceof Error ? error.message : '网络请求失败'}`
            });
        }
    };
    const runAds = async ()=>{
        client.getAuth();
        const day = formatChinaDay(now());
        const target = getSettings().adCount;
        if (target <= 0) return createResult({
            ok: true,
            message: '广告任务未配置次数'
        });
        const previous = state.persisted.adTaskDates[day];
        let done = Math.min(previous?.done ?? 0, target);
        if (done >= target) return createResult({
            ok: true,
            message: `广告任务今日已完成 ${done}/${target}`
        });
        const startDone = done;
        let lastMessage = '';
        let retryable = false;
        let exhausted = false;
        while(done < target && !state.cancelRequested){
            if (done > startDone) await sleep(AD_TASK_INTERVAL_MS);
            if (state.cancelRequested) break;
            try {
                const end = Date.now();
                const result = await client.reportAdPlay(end - 30000, end);
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
                state.persisted.adTaskDates[day] = {
                    done,
                    message: lastMessage,
                    updatedAt: Date.now()
                };
                delete state.persisted.futureLimits[day];
                await persist();
            } catch (error) {
                lastMessage = error instanceof Error ? error.message : '网络请求失败';
                retryable = true;
                break;
            }
        }
        if (done !== (previous?.done ?? 0)) {
            state.persisted.adTaskDates[day] = {
                done,
                message: lastMessage,
                updatedAt: Date.now()
            };
            await persist();
        }
        if (state.cancelRequested) return createResult({
            ok: false,
            changed: done > startDone,
            canceled: true,
            message: `广告任务已取消，完成 ${done}/${target}`
        });
        if (done >= target) return createResult({
            ok: true,
            changed: done > startDone && !exhausted,
            message: `广告任务今日已完成 ${done}/${target}`
        });
        return createResult({
            ok: false,
            changed: done > startDone,
            retryable,
            message: `广告任务完成 ${done}/${target}：${lastMessage || '执行失败'}`
        });
    };
    const execute = ()=>{
        if (operationInFlight) return operationInFlight;
        state.running = true;
        state.cancelRequested = false;
        operationSettings = normalizeSettings({
            ...state.settings
        });
        operationInFlight = (async ()=>{
            try {
                const results = [];
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
                    ok: results.every((result)=>result.ok),
                    changed: results.some((result)=>result.changed),
                    limited: results.some((result)=>result.limited),
                    retryable: results.some((result)=>result.retryable),
                    canceled: results.some((result)=>result.canceled),
                    message: results.map((result)=>result.message).filter(Boolean).join('；')
                });
            } catch (error) {
                return createResult({
                    ok: false,
                    retryable: true,
                    message: error instanceof Error ? error.message : '自动任务执行失败'
                });
            }
        })().finally(()=>{
            state.running = false;
            state.cancelRequested = false;
            operationSettings = null;
            operationInFlight = null;
        });
        return operationInFlight;
    };
    return {
        runAll: execute,
        cancel () {
            if (!state.running) return;
            state.cancelRequested = true;
            interruptWait?.();
        }
    };
};
const GATEWAY = 'https://gateway.kugou.com';
const LITE_SALT = 'LnT6xpN3khm36zse0QzvmgTZ3waWdRSA';
const LITE_APP_ID = 3116;
const LITE_CLIENT_VERSION = 11440;
const USER_AGENT = 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi';
const kugou_asRecord = (value)=>null === value || 'object' != typeof value || Array.isArray(value) ? null : value;
const readString = (value)=>'string' == typeof value || 'number' == typeof value ? String(value) : '';
const readNumber = (value)=>{
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
};
const getEchoKugouAuth = (ctx)=>{
    const root = kugou_asRecord(ctx.pinia.state.value);
    const user = kugou_asRecord(kugou_asRecord(root?.user)?.info);
    const device = kugou_asRecord(kugou_asRecord(root?.device)?.info);
    const token = readString(user?.token);
    const userId = readNumber(user?.userid ?? user?.userId);
    const mid = readString(device?.mid);
    const dfid = readString(device?.dfid);
    const uuid = readString(device?.uuid) || '-';
    if (!token || userId <= 0) throw new Error('请先在 EchoMusic 登录酷狗账号');
    if (!mid || !dfid) throw new Error('EchoMusic 设备信息尚未准备完成，请稍后重试');
    return {
        token,
        userId,
        mid,
        dfid,
        uuid
    };
};
const MD5_SHIFT = (()=>{
    const base = [
        7,
        12,
        17,
        22,
        5,
        9,
        14,
        20,
        4,
        11,
        16,
        23,
        6,
        10,
        15,
        21
    ];
    return Array.from({
        length: 64
    }, (_, index)=>base[4 * Math.floor(index / 16) + index % 4]);
})();
const MD5_CONSTANT = Array.from({
    length: 64
}, (_, index)=>Math.floor(4294967296 * Math.abs(Math.sin(index + 1))));
const md5Cycle = (state, block)=>{
    let [a, b, c, d] = state;
    for(let index = 0; index < 64; index += 1){
        let value;
        let word;
        if (index < 16) {
            value = b & c | ~b & d;
            word = index;
        } else if (index < 32) {
            value = d & b | ~d & c;
            word = (5 * index + 1) % 16;
        } else if (index < 48) {
            value = b ^ c ^ d;
            word = (3 * index + 5) % 16;
        } else {
            value = c ^ (b | ~d);
            word = 7 * index % 16;
        }
        const mixed = value + a + MD5_CONSTANT[index] + block[word] | 0;
        a = d;
        d = c;
        c = b;
        b = b + (mixed << MD5_SHIFT[index] | mixed >>> 32 - MD5_SHIFT[index]) | 0;
    }
    state[0] = state[0] + a | 0;
    state[1] = state[1] + b | 0;
    state[2] = state[2] + c | 0;
    state[3] = state[3] + d | 0;
};
const md5Block = (value)=>{
    const block = [];
    for(let index = 0; index < 64; index += 4)block[index >> 2] = value.charCodeAt(index) + (value.charCodeAt(index + 1) << 8) + (value.charCodeAt(index + 2) << 16) + (value.charCodeAt(index + 3) << 24);
    return block;
};
const md5 = (value)=>{
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    for (const byte of bytes)binary += String.fromCharCode(byte);
    const state = [
        1732584193,
        -271733879,
        -1732584194,
        271733878
    ];
    let offset = 64;
    for(; offset <= binary.length; offset += 64)md5Cycle(state, md5Block(binary.substring(offset - 64, offset)));
    const rest = binary.substring(offset - 64);
    const tail = new Array(16).fill(0);
    let index = 0;
    for(; index < rest.length; index += 1)tail[index >> 2] |= rest.charCodeAt(index) << (index % 4 << 3);
    tail[index >> 2] |= 0x80 << (index % 4 << 3);
    if (index > 55) {
        md5Cycle(state, tail);
        tail.fill(0);
    }
    tail[14] = 8 * binary.length;
    md5Cycle(state, tail);
    const hex = '0123456789abcdef';
    return state.map((word)=>Array.from({
            length: 4
        }, (_, byte)=>`${hex[word >> 8 * byte + 4 & 15]}${hex[word >> 8 * byte & 15]}`).join('')).join('');
};
const signAndroidLite = (params, body = '')=>{
    const query = Object.keys(params).sort().map((key)=>`${key}=${params[key]}`).join('');
    return md5(`${LITE_SALT}${query}${body}${LITE_SALT}`);
};
const parseKugouResult = (payload)=>{
    const record = kugou_asRecord(payload);
    if (!record) return {
        ok: false,
        code: -1,
        status: 0,
        message: '酷狗接口返回空响应',
        data: null,
        raw: payload
    };
    const code = readNumber(record.error_code ?? record.err_code ?? record.errcode);
    const status = void 0 === record.status ? 1 : readNumber(record.status);
    const ok = 0 === code && 0 !== status && false !== record.success;
    const message = readString(record.error_msg) || readString(record.errmsg) || readString(record.msg) || readString(record.message) || (ok ? '成功' : `酷狗接口错误 (${code ? `error_code: ${code}` : `status: ${status}`})`);
    return {
        ok,
        code,
        status,
        message,
        data: record.data ?? null,
        raw: payload
    };
};
const buildUrl = (baseUrl, path, params)=>{
    const query = Object.entries(params).map(([key, value])=>`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join('&');
    return `${baseUrl}${path}?${query}`;
};
const createKugouClient = (ctx)=>{
    const request = async (path, options = {})=>{
        const auth = getEchoKugouAuth(ctx);
        const clienttime = Math.floor(Date.now() / 1000);
        const params = {
            dfid: auth.dfid,
            mid: auth.mid,
            uuid: '-',
            appid: LITE_APP_ID,
            clientver: LITE_CLIENT_VERSION,
            clienttime,
            token: auth.token,
            userid: auth.userId,
            ...options.params
        };
        const bodyText = options.body ? JSON.stringify(options.body) : '';
        params.signature = signAndroidLite(params, bodyText);
        const response = await ctx.net.request({
            url: buildUrl(options.baseUrl ?? GATEWAY, path, params),
            method: options.method ?? 'GET',
            headers: {
                'User-Agent': USER_AGENT,
                dfid: auth.dfid,
                mid: auth.mid,
                clienttime: String(clienttime),
                'kg-rc': '1',
                'kg-thash': '5d816a0',
                'kg-rec': '1',
                'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F',
                ...options.contentType ? {
                    'Content-Type': options.contentType
                } : {}
            },
            ...options.body ? {
                body: options.body
            } : {},
            responseType: 'json',
            timeoutMs: 20000
        });
        const result = parseKugouResult(response.data);
        return response.status >= 200 && response.status < 300 ? result : {
            ...result,
            ok: false,
            message: result.message || `酷狗接口 HTTP ${response.status}`
        };
    };
    return {
        getAuth: ()=>getEchoKugouAuth(ctx),
        claimDayVip: (day)=>request('/youth/v1/recharge/receive_vip_listen_song', {
                method: 'POST',
                params: {
                    source_id: 90139,
                    receive_day: day
                },
                contentType: 'application/x-www-form-urlencoded'
            }),
        upgradeDayVip: ()=>request('/youth/v1/listen_song/upgrade_vip_reward', {
                method: 'POST',
                params: {
                    kugouid: getEchoKugouAuth(ctx).userId,
                    ad_type: 1
                }
            }),
        reportAdPlay: (playStart, playEnd)=>request('/youth/v1/ad/play_report', {
                method: 'POST',
                body: {
                    ad_id: 12307537187,
                    play_start: playStart,
                    play_end: playEnd
                },
                contentType: 'application/json; charset=utf-8'
            })
    };
};
const SETTINGS_SAVE_DELAY_MS = 350;
const createSettingsComponent = (ctx, state, onSettingsSaved)=>ctx.vue.defineComponent({
        name: 'KugouConceptVipSettings',
        setup () {
            const { defineAsyncComponent, h, reactive, ref } = ctx.vue;
            const Switch = defineAsyncComponent(ctx.ui.components.Switch);
            const Slider = defineAsyncComponent(ctx.ui.components.Slider);
            const draft = reactive(normalizeSettings(state.settings));
            const saveStatus = ref('idle');
            const savedAt = ref(0);
            let saveTimer = 0;
            let saveRevision = 0;
            let saveQueue = Promise.resolve();
            let lastSaved = normalizeSettings(state.settings);
            const formatTime = (timestamp)=>timestamp ? new Intl.DateTimeFormat('zh-CN', {
                    timeZone: 'Asia/Shanghai',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    hour12: false
                }).format(new Date(timestamp)) : '';
            const commitSettings = (revision)=>{
                window.clearTimeout(saveTimer);
                const next = normalizeSettings({
                    ...draft
                });
                state.settings = next;
                const save = async ()=>{
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
            const queueSettingsSave = (delay = SETTINGS_SAVE_DELAY_MS)=>{
                window.clearTimeout(saveTimer);
                const revision = ++saveRevision;
                state.settings = normalizeSettings({
                    ...draft
                });
                saveStatus.value = 'saving';
                saveTimer = window.setTimeout(()=>commitSettings(revision), delay);
            };
            const switchRow = (label, description, key)=>h('label', {
                    class: 'echo-vip-setting-row'
                }, [
                    h('span', {
                        class: 'echo-vip-setting-copy'
                    }, [
                        h('strong', label),
                        h('small', description)
                    ]),
                    h(Switch, {
                        modelValue: draft[key],
                        'onUpdate:modelValue': (value)=>{
                            draft[key] = Boolean(value);
                            queueSettingsSave(0);
                        }
                    })
                ]);
            const sliderRow = (label, description, key, maximum, suffix, disabled = false)=>h('div', {
                    class: `echo-vip-slider-row${disabled ? ' is-disabled' : ''}`
                }, [
                    h('span', {
                        class: 'echo-vip-setting-copy'
                    }, [
                        h('strong', label),
                        h('small', description)
                    ]),
                    h(Slider, {
                        modelValue: draft[key],
                        min: 0,
                        max: maximum,
                        step: 1,
                        showValue: true,
                        valueSuffix: suffix,
                        disabled,
                        'onUpdate:modelValue': (value)=>{
                            draft[key] = Number(value);
                            queueSettingsSave();
                        }
                    })
                ]);
            return ()=>h('div', {
                    class: 'echo-vip-settings'
                }, [
                    h('section', {
                        class: 'echo-vip-options'
                    }, [
                        h('div', {
                            class: 'echo-vip-section-heading'
                        }, [
                            h('h3', '自动任务'),
                            h('p', 'EchoMusic 启动后执行，并在保持运行时于北京时间每天 09:00 执行。')
                        ]),
                        switchRow('启用自动任务', '关闭后取消尚未开始的任务和失败重试', 'autoClaim'),
                        sliderRow('启动延迟', '默认等待 60 秒，确保酷狗登录态和设备信息已加载', 'delaySeconds', 60, ' 秒'),
                        switchRow('每日自动升级', '领取今日 VIP 后增加概念会员时长', 'autoUpgrade'),
                        switchRow('自动执行广告任务', '每次约 35 秒，8 次约需 4 至 5 分钟', 'adEnabled'),
                        sliderRow('每日广告次数', '每天最多 8 次，酷狗提示次数用光时自动视为完成', 'adCount', 8, ' 次', !draft.adEnabled),
                        sliderRow('最多预领未来天数', '达到会员可预领上限后，当天不再重复请求', 'futureDays', 7, ' 天'),
                        switchRow('任务结果通知', '获得新权益、达到预领上限或执行失败时通知', 'notifySuccess')
                    ]),
                    h('footer', {
                        class: `echo-vip-save-state is-${saveStatus.value}`
                    }, [
                        'saving' === saveStatus.value ? '正在自动保存...' : 'saved' === saveStatus.value ? `已自动保存 ${formatTime(savedAt.value)}` : 'error' === saveStatus.value ? '自动保存失败，请重试' : '设置修改后自动保存'
                    ])
                ]);
        }
    });
async function activate(ctx) {
    const [savedSettings, savedState] = await Promise.all([
        ctx.storage.get(SETTINGS_KEY),
        ctx.storage.get(STATE_KEY)
    ]);
    const state = ctx.vue.reactive({
        settings: normalizeSettings(savedSettings),
        persisted: normalizePersistedState(savedState),
        running: false,
        cancelRequested: false
    });
    const service = createVipService(ctx, state, createKugouClient(ctx));
    let pendingRunTimer = 0;
    let dailyTimer = 0;
    let retryTimer = 0;
    let pendingRunIgnoresCompletion = false;
    const persistState = ()=>ctx.storage.set(STATE_KEY, state.persisted);
    const clearPendingRun = ()=>{
        window.clearTimeout(pendingRunTimer);
        pendingRunTimer = 0;
    };
    const clearRetry = ()=>{
        window.clearTimeout(retryTimer);
        retryTimer = 0;
    };
    const scheduleRetry = async (day, message)=>{
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
        retryTimer = window.setTimeout(()=>{
            retryTimer = 0;
            runAutomatic(true);
        }, delay);
        if (state.settings.notifySuccess) ctx.toast.warning(`酷狗 VIP 自动任务暂未完成，将在 ${delay / 60000} 分钟后重试`);
    };
    const runAutomatic = async (ignoreCompleted = false)=>{
        if (!state.settings.autoClaim || state.running) return;
        const day = formatChinaDay();
        if (!ignoreCompleted && state.persisted.autoRunDates[day]?.ok) return;
        const result = await service.runAll();
        if (result.canceled || !state.settings.autoClaim) return;
        if (result.ok) {
            state.persisted.autoRunDates[day] = {
                ok: true,
                message: result.message,
                updatedAt: Date.now()
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
        if (result.retryable) await scheduleRetry(day, result.message);
        else if (state.settings.notifySuccess) ctx.toast.danger(`酷狗 VIP 自动任务失败：${result.message}`);
    };
    const scheduleRun = (delaySeconds, ignoreCompleted)=>{
        clearPendingRun();
        if (!state.settings.autoClaim) return;
        pendingRunIgnoresCompletion = ignoreCompleted;
        pendingRunTimer = window.setTimeout(()=>{
            pendingRunTimer = 0;
            runAutomatic(pendingRunIgnoresCompletion);
        }, 1000 * Math.max(0, delaySeconds));
    };
    const scheduleDaily = ()=>{
        window.clearTimeout(dailyTimer);
        const delay = Math.max(1000, nextChinaDailyRunAt().getTime() - Date.now());
        dailyTimer = window.setTimeout(()=>{
            runAutomatic(false).finally(scheduleDaily);
        }, delay);
    };
    const onSettingsSaved = (previous, next)=>{
        const taskChanged = previous.autoUpgrade !== next.autoUpgrade || previous.adEnabled !== next.adEnabled || previous.adCount !== next.adCount || previous.futureDays !== next.futureDays;
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
            persistState();
            scheduleRun(next.delaySeconds, true);
            return;
        }
        if (previous.delaySeconds !== next.delaySeconds && pendingRunTimer) scheduleRun(next.delaySeconds, pendingRunIgnoresCompletion);
    };
    if (state.settings.autoClaim) scheduleRun(state.settings.delaySeconds, false);
    scheduleDaily();
    ctx.ui.settings.define({
        title: '酷狗概念版 VIP',
        component: createSettingsComponent(ctx, state, onSettingsSaved)
    });
    ctx.dispose(()=>{
        service.cancel();
        clearPendingRun();
        clearRetry();
        window.clearTimeout(dailyTimer);
    });
}
function deactivate() {}
export { DEFAULT_SETTINGS, activate, buildTargetDates, deactivate, formatChinaDay, getEchoKugouAuth, md5, nextChinaDailyRunAt, parseKugouResult, signAndroidLite };
