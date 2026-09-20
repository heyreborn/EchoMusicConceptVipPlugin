const SETTINGS_KEY = 'settings-v2';
const STATE_KEY = 'state-v2';
const AD_TASK_INTERVAL_MS = 35000;
const CLAIM_TASK_INTERVAL_MS = 1200;
const MAX_HISTORY = 20;
const DEFAULT_SETTINGS = Object.freeze({
    autoClaim: false,
    autoUpgrade: false,
    notifySuccess: true,
    futureDays: 7,
    delaySeconds: 60,
    adEnabled: false,
    adCount: 8
});
const EMPTY_STATUS = Object.freeze({
    kind: 'idle',
    day: '',
    message: '尚未执行',
    updatedAt: 0
});
Object.freeze({
    claimedDates: {},
    upgradeDates: {},
    adTaskDates: {},
    history: [],
    lastResult: ''
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
        history: Array.isArray(source?.history) ? source.history.slice(0, MAX_HISTORY) : [],
        lastResult: 'string' == typeof source?.lastResult ? source.lastResult : ''
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
const findBusiVip = (payload)=>{
    const stack = [
        payload
    ];
    const seen = new WeakSet();
    while(stack.length > 0){
        const current = stack.pop();
        if (!current || 'object' != typeof current || seen.has(current)) continue;
        seen.add(current);
        if (Array.isArray(current)) {
            stack.push(...current);
            continue;
        }
        for (const [key, value] of Object.entries(current)){
            if ('busi_vip' === key && Array.isArray(value)) return value.filter((item)=>Boolean(asRecord(item)));
            if (value && 'object' == typeof value) stack.push(value);
        }
    }
    return [];
};
const formatEndTime = (value)=>{
    if (null == value || '' === value) return '';
    const numeric = Number(value);
    const date = Number.isFinite(numeric) ? new Date(numeric > 1e12 ? numeric : 1000 * numeric) : new Date(String(value));
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', {
        hour12: false
    });
};
const formatVipText = (payload)=>{
    const items = findBusiVip(payload);
    const labels = {
        tvip: '畅听会员',
        svip: '概念会员'
    };
    const lines = items.flatMap((item)=>{
        const type = String(item.product_type ?? '').toLowerCase();
        if (!labels[type]) return [];
        const active = 1 === Number(item.is_vip);
        const endTime = active ? formatEndTime(item.vip_end_time) : '';
        return [
            `${labels[type]}：${active ? '生效中' : '未生效'}${endTime ? `，到期 ${endTime}` : ''}`
        ];
    });
    return lines.length > 0 ? lines.join('；') : '暂无畅听/概念会员记录';
};
const isAlreadyClaimedResult = (result)=>131001 === result.code || /已领|已经领|重复领|领过/.test(result.message);
const isAlreadyUpgradedResult = (result)=>297002 === result.code || /已经领取过升级|已升级|重复升级/.test(result.message);
const isFutureDurationInsufficient = (result)=>/未来.*时长不足|未来时长不足/.test(result.message);
const createResult = (patch)=>({
        claimed: false,
        alreadyClaimed: false,
        upgraded: false,
        ...patch
    });
const createVipService = (ctx, state, client, deps = {})=>{
    const now = deps.now ?? (()=>new Date());
    let operationInFlight = null;
    let refreshInFlight = null;
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
    const persist = async ()=>{
        await ctx.storage.set(STATE_KEY, state.persisted);
    };
    const setStatus = (kind, day, message)=>{
        state.status = {
            kind,
            day,
            message,
            updatedAt: Date.now()
        };
    };
    const setProgress = (phase, current, total, label)=>{
        state.progress = {
            phase,
            current,
            total,
            label
        };
    };
    const addHistory = async (entry)=>{
        state.persisted.history = [
            {
                ...entry,
                id: `${entry.startedAt}-${Math.random().toString(36).slice(2, 8)}`
            },
            ...state.persisted.history
        ].slice(0, MAX_HISTORY);
        state.persisted.lastResult = entry.message;
        await persist();
    };
    const claimDates = async (options, scope, specifiedDay = '')=>{
        client.getAuth();
        const today = formatChinaDay(now());
        const configuredDates = buildTargetDates(getSettings(), now());
        const dates = 'today' === scope ? [
            today
        ] : 'future' === scope ? configuredDates.filter((day)=>day !== today) : 'specified' === scope ? [
            specifiedDay
        ] : configuredDates;
        if (0 === dates.length) {
            const message = '未配置未来预领日期';
            setStatus('idle', today, message);
            return createResult({
                ok: true,
                message
            });
        }
        const targets = options.force ? dates : dates.filter((day)=>!state.persisted.claimedDates[day]?.ok);
        if (0 === targets.length) {
            const message = '目标日期均已完成领取';
            setStatus('already-claimed', formatChinaDay(now()), message);
            return createResult({
                ok: true,
                claimed: true,
                alreadyClaimed: true,
                message
            });
        }
        let claimed = 0;
        let already = 0;
        const failures = [];
        let insufficientDay = '';
        for(let index = 0; index < targets.length; index += 1){
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
                        updatedAt: Date.now()
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
                if (20018 === result.code) break;
            } catch (error) {
                failures.push(`${day}: ${error instanceof Error ? error.message : '网络请求失败'}`);
                break;
            }
        }
        if (state.cancelRequested) {
            const message = `领取已取消，完成 ${claimed + already}/${targets.length} 天`;
            setStatus('canceled', formatChinaDay(now()), message);
            return createResult({
                ok: false,
                claimed: claimed + already > 0,
                canceled: true,
                message
            });
        }
        const parts = [
            claimed ? `新领取 ${claimed} 天` : '',
            already ? `${already} 天已领取` : '',
            insufficientDay ? `已达当前可预领上限，停在 ${insufficientDay}` : '',
            failures.length && !insufficientDay ? `失败 ${failures.length} 天：${failures[0]}` : ''
        ].filter(Boolean);
        const message = parts.join('；') || '领取任务已完成';
        const limited = Boolean(insufficientDay);
        setStatus(limited ? 'limit' : failures.length ? claimed + already > 0 ? 'partial' : 'error' : already && !claimed ? 'already-claimed' : 'claimed', today, message);
        return createResult({
            ok: 0 === failures.length,
            claimed: claimed + already > 0,
            alreadyClaimed: already > 0,
            limited,
            message
        });
    };
    const runAdsInternal = async (options)=>{
        client.getAuth();
        const day = formatChinaDay(now());
        const settings = getSettings();
        const target = settings.adEnabled || options.includeAds ? settings.adCount : 0;
        if (target <= 0) return createResult({
            ok: true,
            message: '广告任务未启用'
        });
        const previous = state.persisted.adTaskDates[day];
        let done = options.force ? 0 : Math.min(previous?.done ?? 0, target);
        if (done >= target) return createResult({
            ok: true,
            message: `广告任务今日已完成 ${done} 次`
        });
        const startIndex = done;
        let lastMessage = '';
        for(let index = done; index < target; index += 1){
            if (state.cancelRequested) break;
            if (index > startIndex) await sleep(AD_TASK_INTERVAL_MS);
            if (state.cancelRequested) break;
            setProgress('ad', index + 1, target, `正在执行广告任务 ${index + 1}/${target}`);
            setStatus('advertising', day, `正在执行广告任务 ${index + 1}/${target}`);
            try {
                const end = Date.now();
                const result = await client.reportAdPlay(end - 30000, end);
                if (!result.ok) {
                    lastMessage = result.message;
                    break;
                }
                const data = asRecord(result.data);
                done = Math.max(done + 1, clampInteger(data?.done, 0, 8, done + 1));
                lastMessage = result.message;
                state.persisted.adTaskDates[day] = {
                    done,
                    message: lastMessage,
                    updatedAt: Date.now()
                };
                await persist();
                if (Number(data?.remain) <= 0) break;
            } catch (error) {
                lastMessage = error instanceof Error ? error.message : '广告任务网络请求失败';
                break;
            }
        }
        const completed = done >= target;
        const message = state.cancelRequested ? `广告任务已取消，今日完成 ${done}/${target} 次` : completed ? `广告任务完成 ${done}/${target} 次` : `广告任务完成 ${done}/${target} 次${lastMessage ? `：${lastMessage}` : ''}`;
        setStatus(state.cancelRequested ? 'canceled' : completed ? 'claimed' : done > 0 ? 'partial' : 'error', day, message);
        return createResult({
            ok: completed,
            claimed: false,
            canceled: state.cancelRequested,
            message
        });
    };
    const upgradeInternal = async (options)=>{
        client.getAuth();
        const day = formatChinaDay(now());
        if (!options.force && state.persisted.upgradeDates[day]?.ok) {
            const message = '会员今日已升级';
            setStatus('upgraded', day, message);
            return createResult({
                ok: true,
                claimed: true,
                upgraded: true,
                message
            });
        }
        setProgress('upgrade', 1, 1, '正在升级会员');
        setStatus('upgrading', day, '正在升级会员');
        try {
            const result = await client.upgradeDayVip();
            if (result.ok || isAlreadyUpgradedResult(result)) {
                const message = result.ok ? result.message : '会员今日已升级';
                state.persisted.upgradeDates[day] = {
                    ok: true,
                    already: !result.ok,
                    message,
                    updatedAt: Date.now()
                };
                await persist();
                setStatus('upgraded', day, message);
                return createResult({
                    ok: true,
                    claimed: true,
                    alreadyClaimed: !result.ok,
                    upgraded: true,
                    message
                });
            }
            setStatus('error', day, result.message);
            return createResult({
                ok: false,
                message: result.message
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : '会员升级网络请求失败';
            setStatus('error', day, message);
            return createResult({
                ok: false,
                message
            });
        }
    };
    const refresh = (options = {})=>{
        if (refreshInFlight) return refreshInFlight;
        state.refreshing = true;
        state.refreshMessage = '正在刷新状态';
        refreshInFlight = (async ()=>{
            const [record, vip] = await Promise.allSettled([
                client.getMonthVipRecord(),
                client.getUnionVip()
            ]);
            const recordOk = 'fulfilled' === record.status && record.value.ok;
            const vipOk = 'fulfilled' === vip.status && vip.value.ok;
            if (vipOk) {
                state.vipDetail = vip.value.raw;
                state.vipText = formatVipText(vip.value.raw);
            } else {
                const message = 'fulfilled' === vip.status ? vip.value.message : vip.reason instanceof Error ? vip.reason.message : '查询失败';
                state.vipText = `会员状态查询失败：${message}`;
            }
            if (recordOk) {
                state.monthRecord = record.value.raw;
                let changed = false;
                for (const targetDay of buildTargetDates(state.settings, now()))if (hasClaimedDay(record.value.raw, targetDay)) {
                    state.persisted.claimedDates[targetDay] = {
                        ok: true,
                        already: true,
                        message: `${targetDay} 已领取`,
                        updatedAt: Date.now()
                    };
                    changed = true;
                }
                if (changed) await persist();
            }
            const recordError = 'fulfilled' === record.status ? record.value.message : record.reason instanceof Error ? record.reason.message : '领取记录查询失败';
            const vipError = 'fulfilled' === vip.status ? vip.value.message : vip.reason instanceof Error ? vip.reason.message : '会员状态查询失败';
            state.refreshedAt = Date.now();
            if (recordOk && vipOk) state.refreshMessage = '状态已更新';
            else if (recordOk) state.refreshMessage = `领取状态已更新；会员查询失败：${vipError}`;
            else if (vipOk) state.refreshMessage = `会员状态已更新；领取记录查询失败：${recordError}`;
            else state.refreshMessage = false === options.reportFailure ? '后台刷新失败' : `刷新失败：${recordError}`;
            return recordOk;
        })().finally(()=>{
            state.refreshing = false;
            refreshInFlight = null;
        });
        return refreshInFlight;
    };
    const execute = (source, operation)=>{
        if (operationInFlight) return operationInFlight;
        state.running = true;
        state.cancelRequested = false;
        operationSettings = normalizeSettings({
            ...state.settings
        });
        const startedAt = Date.now();
        operationInFlight = (async ()=>{
            let result;
            try {
                result = await operation();
            } catch (error) {
                const message = error instanceof Error ? error.message : '任务执行失败';
                setStatus('error', formatChinaDay(now()), message);
                result = createResult({
                    ok: false,
                    message
                });
            }
            const outcome = result.canceled ? 'canceled' : result.limited ? 'limit' : result.ok ? 'success' : result.claimed || result.upgraded ? 'partial' : 'failed';
            await addHistory({
                source,
                startedAt,
                finishedAt: Date.now(),
                ok: result.ok,
                outcome,
                message: result.message
            });
            if ('auto' === source && state.settings.notifySuccess) ctx.toast[result.ok ? 'success' : 'warning'](result.message);
            return result;
        })().finally(()=>{
            state.running = false;
            state.cancelRequested = false;
            setProgress('idle', 0, 0, '');
            operationSettings = null;
            operationInFlight = null;
        });
        return operationInFlight;
    };
    const claimConfigured = (options = {})=>execute(options.source ?? 'manual', ()=>claimDates(options, 'configured'));
    const claimToday = (options = {})=>execute(options.source ?? 'manual', ()=>claimDates(options, 'today'));
    const claimFuture = (options = {})=>execute(options.source ?? 'manual', ()=>claimDates(options, 'future'));
    const claimDate = (day, options = {})=>execute(options.source ?? 'manual', async ()=>{
            const normalizedDay = day.trim();
            if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedDay) || addDays(normalizedDay, 0) !== normalizedDay) throw new Error('请选择有效的领取日期');
            if (normalizedDay < formatChinaDay(now())) throw new Error('不能领取早于今天的日期');
            return claimDates(options, 'specified', normalizedDay);
        });
    const runAds = (options = {})=>execute(options.source ?? 'manual', ()=>runAdsInternal({
                ...options,
                includeAds: true
            }));
    const upgrade = (options = {})=>execute(options.source ?? 'manual', ()=>upgradeInternal(options));
    const runAll = (options = {})=>execute(options.source ?? 'manual', async ()=>{
            const settings = getSettings();
            const initialClaim = await claimDates(options, 'today');
            const messages = [
                initialClaim.message
            ];
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
            if (state.cancelRequested) return createResult({
                ok: false,
                claimed,
                upgraded,
                canceled: true,
                message
            });
            setStatus(limited ? 'limit' : ok ? upgraded ? 'upgraded' : claimed ? 'claimed' : 'idle' : claimed ? 'partial' : 'error', formatChinaDay(now()), message);
            refresh({
                reportFailure: false
            });
            return createResult({
                ok,
                claimed,
                alreadyClaimed,
                upgraded,
                limited,
                message
            });
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
        cancel () {
            if (state.running) {
                state.cancelRequested = true;
                interruptWait?.();
            }
        }
    };
};
const GATEWAY = 'https://gateway.kugou.com';
const VIP_GATEWAY = 'https://kugouvip.kugou.com';
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
        getMonthVipRecord: ()=>request('/youth/v1/activity/get_month_vip_record', {
                params: {
                    latest_limit: 100
                }
            }),
        getUnionVip: ()=>request('/v1/get_union_vip', {
                baseUrl: VIP_GATEWAY,
                params: {
                    busi_type: 'concept',
                    opt_product_types: 'dvip,qvip',
                    product_type: 'svip'
                }
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
const AUTO_CHECK_INTERVAL_MS = 1800000;
const SETTINGS_SAVE_DELAY_MS = 350;
const statusLabel = (status)=>{
    const labels = {
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
        error: '执行失败'
    };
    return labels[status.kind];
};
const historyLabel = (entry)=>{
    const outcome = entry.outcome ?? (entry.ok ? 'success' : 'failed');
    return ({
        success: '完成',
        limit: '已达上限',
        partial: '部分完成',
        canceled: '已取消',
        failed: '失败'
    })[outcome];
};
const formatTime = (timestamp)=>{
    if (!timestamp) return '--';
    return new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).format(new Date(timestamp));
};
const createSettingsComponent = (ctx, state, service, scheduleStartup)=>ctx.vue.defineComponent({
        name: 'KugouConceptVipSettings',
        setup () {
            const { computed, defineAsyncComponent, h, onMounted, reactive, ref } = ctx.vue;
            const Button = defineAsyncComponent(ctx.ui.components.Button);
            const Switch = defineAsyncComponent(ctx.ui.components.Switch);
            const Slider = defineAsyncComponent(ctx.ui.components.Slider);
            const Input = defineAsyncComponent(ctx.ui.components.Input);
            const draft = reactive(normalizeSettings(state.settings));
            const specifiedDay = ref(formatChinaDay());
            const saveStatus = ref('idle');
            const savedAt = ref(0);
            let saveTimer = 0;
            let saveRevision = 0;
            let saveQueue = Promise.resolve();
            let lastSaved = normalizeSettings(state.settings);
            const busy = computed(()=>state.running || state.refreshing);
            const today = computed(()=>formatChinaDay());
            const todayClaimed = computed(()=>Boolean(state.persisted.claimedDates[today.value]?.ok));
            const todayUpgraded = computed(()=>Boolean(state.persisted.upgradeDates[today.value]?.ok));
            const adDone = computed(()=>state.persisted.adTaskDates[today.value]?.done ?? 0);
            const latestFutureDay = computed(()=>Object.entries(state.persisted.claimedDates).filter(([day, record])=>day > today.value && record.ok).map(([day])=>day).sort().at(-1) ?? '');
            const enabledSteps = computed(()=>{
                const steps = [
                    '今日领取'
                ];
                if (draft.autoUpgrade) steps.push('每日升级');
                if (draft.adEnabled && draft.adCount > 0) steps.push(`广告 ${draft.adCount} 次`);
                if (draft.futureDays > 0) steps.push(`最多预领 ${draft.futureDays} 天`);
                return steps.join('、');
            });
            const progressHint = computed(()=>{
                if ('ad' !== state.progress.phase || state.progress.total <= state.progress.current) return '';
                const minutes = Math.max(1, Math.ceil((state.progress.total - state.progress.current) * 35 / 60));
                return `预计还需约 ${minutes} 分钟`;
            });
            const commitSettings = (revision)=>{
                window.clearTimeout(saveTimer);
                const next = normalizeSettings({
                    ...draft
                });
                state.settings = next;
                saveStatus.value = 'saving';
                const save = async ()=>{
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
            const queueSettingsSave = (delay = SETTINGS_SAVE_DELAY_MS)=>{
                window.clearTimeout(saveTimer);
                const revision = ++saveRevision;
                state.settings = normalizeSettings({
                    ...draft
                });
                saveStatus.value = 'saving';
                saveTimer = window.setTimeout(()=>commitSettings(revision), delay);
            };
            onMounted(()=>{
                state.status = {
                    ...EMPTY_STATUS
                };
                service.refresh();
            });
            const run = async (operation)=>{
                if (busy.value) return;
                try {
                    await operation();
                } catch (error) {
                    ctx.toast.danger(error instanceof Error ? error.message : '操作失败');
                }
            };
            const clearHistory = async ()=>{
                state.persisted.history = [];
                state.persisted.lastResult = '';
                await ctx.storage.set(STATE_KEY, state.persisted);
            };
            const button = (label, props)=>h(Button, props, {
                    default: ()=>label
                });
            const statusRow = (label, value, tone)=>h('div', {
                    class: 'echo-vip-summary-row'
                }, [
                    h('span', label),
                    h('strong', {
                        class: `is-${tone}`
                    }, value)
                ]);
            const switchRow = (label, description, key, disabled = false)=>h('label', {
                    class: `echo-vip-setting-row${disabled ? ' is-disabled' : ''}`
                }, [
                    h('span', {
                        class: 'echo-vip-setting-copy'
                    }, [
                        h('strong', label),
                        h('small', description)
                    ]),
                    h(Switch, {
                        modelValue: draft[key],
                        disabled: disabled || state.running,
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
                        disabled: disabled || state.running,
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
                        class: 'echo-vip-overview'
                    }, [
                        h('div', {
                            class: 'echo-vip-section-heading'
                        }, [
                            h('div', [
                                h('h3', '今日任务'),
                                h('p', state.refreshMessage || '尚未刷新状态')
                            ]),
                            button(state.refreshing ? '刷新中...' : '刷新', {
                                variant: 'ghost',
                                size: 'sm',
                                loading: state.refreshing,
                                disabled: busy.value,
                                title: '刷新领取记录和会员状态',
                                onClick: ()=>run(()=>service.refresh())
                            })
                        ]),
                        h('div', {
                            class: 'echo-vip-summary'
                        }, [
                            statusRow('今日 VIP', state.refreshing && !todayClaimed.value ? '查询中' : todayClaimed.value ? '已领取' : '尚未领取', todayClaimed.value ? 'success' : 'muted'),
                            statusRow('每日升级', todayUpgraded.value ? '已完成' : draft.autoUpgrade ? '待执行' : '未启用', todayUpgraded.value ? 'success' : 'muted'),
                            statusRow('广告任务', draft.adEnabled ? `${adDone.value}/${draft.adCount}` : '未启用', adDone.value >= draft.adCount && draft.adCount > 0 ? 'success' : 'muted'),
                            statusRow('未来预领', latestFutureDay.value ? `已领取至 ${latestFutureDay.value}` : '尚未预领', latestFutureDay.value ? 'success' : 'muted')
                        ]),
                        h('p', {
                            class: 'echo-vip-member-status'
                        }, state.vipText),
                        h('div', {
                            class: 'echo-vip-refresh-meta'
                        }, [
                            h('span', state.refreshedAt ? `更新于 ${formatTime(state.refreshedAt)}` : '等待首次刷新'),
                            h('span', `中国日期 ${today.value}`)
                        ])
                    ]),
                    state.running || state.status.updatedAt ? h('section', {
                        class: `echo-vip-task-state is-${state.status.kind}`
                    }, [
                        h('div', {
                            class: 'echo-vip-task-state-line'
                        }, [
                            h('span', {
                                class: `echo-vip-state is-${state.status.kind}`
                            }, statusLabel(state.status)),
                            h('strong', state.status.message)
                        ]),
                        state.running ? h('div', {
                            class: 'echo-vip-progress'
                        }, [
                            h('span', state.progress.label || '任务执行中'),
                            h('span', `${state.progress.current}/${state.progress.total}${progressHint.value ? ` · ${progressHint.value}` : ''}`)
                        ]) : null
                    ]) : null,
                    h('section', {
                        class: 'echo-vip-primary-actions'
                    }, [
                        button(state.running ? '执行中...' : '执行今日任务', {
                            variant: 'primary',
                            size: 'sm',
                            loading: state.running,
                            disabled: busy.value,
                            onClick: ()=>run(()=>service.runAll({
                                        source: 'manual'
                                    }))
                        }),
                        state.running ? button('取消任务', {
                            variant: 'outline',
                            size: 'sm',
                            onClick: ()=>service.cancel()
                        }) : null,
                        h('p', `将执行：${enabledSteps.value}`)
                    ]),
                    h('details', {
                        class: 'echo-vip-more'
                    }, [
                        h('summary', '更多操作'),
                        h('div', {
                            class: 'echo-vip-more-content'
                        }, [
                            h('div', {
                                class: 'echo-vip-secondary-actions'
                            }, [
                                button('仅领取今日', {
                                    variant: 'outline',
                                    size: 'sm',
                                    disabled: busy.value,
                                    onClick: ()=>run(()=>service.claimToday({
                                                source: 'manual'
                                            }))
                                }),
                                button('补领未来日期', {
                                    variant: 'outline',
                                    size: 'sm',
                                    disabled: busy.value || 0 === draft.futureDays,
                                    onClick: ()=>run(()=>service.claimFuture({
                                                source: 'manual'
                                            }))
                                }),
                                button('仅执行升级', {
                                    variant: 'outline',
                                    size: 'sm',
                                    disabled: busy.value,
                                    onClick: ()=>run(()=>service.upgrade({
                                                source: 'manual'
                                            }))
                                }),
                                button('仅执行广告', {
                                    variant: 'outline',
                                    size: 'sm',
                                    disabled: busy.value || 0 === draft.adCount,
                                    onClick: ()=>run(()=>service.runAds({
                                                source: 'manual'
                                            }))
                                })
                            ]),
                            h('div', {
                                class: 'echo-vip-specified-date'
                            }, [
                                h('span', {
                                    class: 'echo-vip-setting-copy'
                                }, [
                                    h('strong', '领取指定日期'),
                                    h('small', '一次性操作，不影响自动任务设置')
                                ]),
                                h('div', [
                                    h(Input, {
                                        class: 'echo-vip-date-input',
                                        type: 'date',
                                        min: today.value,
                                        modelValue: specifiedDay.value,
                                        disabled: busy.value,
                                        'onUpdate:modelValue': (value)=>{
                                            specifiedDay.value = String(value ?? '');
                                        }
                                    }),
                                    button('领取', {
                                        variant: 'outline',
                                        size: 'sm',
                                        disabled: busy.value || !specifiedDay.value,
                                        onClick: ()=>run(()=>service.claimDate(specifiedDay.value, {
                                                    source: 'manual'
                                                }))
                                    })
                                ])
                            ])
                        ])
                    ]),
                    h('section', {
                        class: 'echo-vip-options'
                    }, [
                        h('div', {
                            class: 'echo-vip-section-heading'
                        }, [
                            h('div', [
                                h('h3', '自动任务'),
                                h('p', '设置修改后自动保存')
                            ])
                        ]),
                        switchRow('启动后自动执行', 'EchoMusic 启动并等待登录状态准备完成后执行', 'autoClaim'),
                        sliderRow('启动延迟', '默认等待 60 秒，避免登录态和设备信息尚未加载', 'delaySeconds', 60, ' 秒', !draft.autoClaim),
                        switchRow('自动执行每日升级', '领取今日 VIP 后增加概念会员时长', 'autoUpgrade'),
                        switchRow('自动执行广告任务', '每次约 35 秒，8 次约需 4 至 5 分钟', 'adEnabled'),
                        sliderRow('每日广告次数', '每天最多 8 次，每次增加的时长由酷狗返回为准', 'adCount', 8, ' 次', !draft.adEnabled),
                        sliderRow('最多预领未来天数', '实际天数取决于会员剩余时长，达到上限后自动停止', 'futureDays', 7, ' 天'),
                        switchRow('任务结果通知', '自动任务结束后显示应用内通知', 'notifySuccess')
                    ]),
                    state.persisted.history.length ? h('section', {
                        class: 'echo-vip-history'
                    }, [
                        h('div', {
                            class: 'echo-vip-history-header'
                        }, [
                            h('div', [
                                h('h3', '最近执行记录'),
                                h('p', '保留最近 20 次任务')
                            ]),
                            button('清除', {
                                variant: 'ghost',
                                size: 'xs',
                                disabled: busy.value,
                                onClick: clearHistory
                            })
                        ]),
                        ...state.persisted.history.slice(0, 8).map((entry)=>{
                            const outcome = entry.outcome ?? (entry.ok ? 'success' : 'failed');
                            return h('div', {
                                class: 'echo-vip-history-row',
                                key: entry.id
                            }, [
                                h('time', formatTime(entry.finishedAt)),
                                h('span', {
                                    class: `is-${outcome}`
                                }, historyLabel(entry)),
                                h('p', entry.message)
                            ]);
                        })
                    ]) : null,
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
        status: {
            ...EMPTY_STATUS
        },
        monthRecord: null,
        vipDetail: null,
        vipText: '尚未查询会员状态',
        running: false,
        refreshing: false,
        refreshMessage: '尚未刷新状态',
        refreshedAt: 0,
        cancelRequested: false,
        progress: {
            phase: 'idle',
            current: 0,
            total: 0,
            label: ''
        }
    });
    const client = createKugouClient(ctx);
    const service = createVipService(ctx, state, client);
    let startupTimer = 0;
    const scheduleStartup = ()=>{
        window.clearTimeout(startupTimer);
        if (!state.settings.autoClaim) return;
        startupTimer = window.setTimeout(()=>{
            if (!state.refreshing) service.runAll({
                source: 'auto'
            });
        }, 1000 * state.settings.delaySeconds);
    };
    scheduleStartup();
    const intervalTimer = window.setInterval(()=>{
        if (state.settings.autoClaim && !state.refreshing) service.runAll({
            source: 'auto'
        });
    }, AUTO_CHECK_INTERVAL_MS);
    ctx.ui.settings.define({
        title: '酷狗概念版 VIP',
        component: createSettingsComponent(ctx, state, service, scheduleStartup)
    });
    ctx.ui.titlebar.register({
        id: 'claim-today',
        title: '领取今日 VIP',
        tooltip: '直连酷狗领取今日 VIP',
        icon: 'tabler:gift',
        defaultPlacement: 'more',
        order: 300,
        disabled: ()=>state.running || state.refreshing,
        onClick: ()=>service.claimToday({
                source: 'manual'
            })
    });
    ctx.dispose(()=>{
        service.cancel();
        window.clearTimeout(startupTimer);
        window.clearInterval(intervalTimer);
    });
}
function deactivate() {}
export { DEFAULT_SETTINGS, activate, buildTargetDates, deactivate, formatChinaDay, getEchoKugouAuth, hasClaimedDay, md5, parseKugouResult, signAndroidLite };
