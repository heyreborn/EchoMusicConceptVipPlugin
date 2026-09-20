import type { EchoPluginContext, KugouApiResult, KugouAuth, KugouClient } from './types';

const GATEWAY = 'https://gateway.kugou.com';
const VIP_GATEWAY = 'https://kugouvip.kugou.com';
const LITE_SALT = 'LnT6xpN3khm36zse0QzvmgTZ3waWdRSA';
const LITE_APP_ID = 3116;
const LITE_CLIENT_VERSION = 11440;
const USER_AGENT = 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi';

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const readString = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';

const readNumber = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const getEchoKugouAuth = (ctx: EchoPluginContext): KugouAuth => {
  const root = asRecord(ctx.pinia.state.value);
  const user = asRecord(asRecord(root?.user)?.info);
  const device = asRecord(asRecord(root?.device)?.info);
  const token = readString(user?.token);
  const userId = readNumber(user?.userid ?? user?.userId);
  const mid = readString(device?.mid);
  const dfid = readString(device?.dfid);
  const uuid = readString(device?.uuid) || '-';
  if (!token || userId <= 0) throw new Error('请先在 EchoMusic 登录酷狗账号');
  if (!mid || !dfid) throw new Error('EchoMusic 设备信息尚未准备完成，请稍后重试');
  return { token, userId, mid, dfid, uuid };
};

const MD5_SHIFT = (() => {
  const base = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  return Array.from({ length: 64 }, (_, index) => base[Math.floor(index / 16) * 4 + (index % 4)]);
})();

const MD5_CONSTANT = Array.from({ length: 64 }, (_, index) =>
  Math.floor(Math.abs(Math.sin(index + 1)) * 4294967296),
);

const md5Cycle = (state: number[], block: number[]) => {
  let [a, b, c, d] = state;
  for (let index = 0; index < 64; index += 1) {
    let value: number;
    let word: number;
    if (index < 16) {
      value = (b & c) | (~b & d);
      word = index;
    } else if (index < 32) {
      value = (d & b) | (~d & c);
      word = (5 * index + 1) % 16;
    } else if (index < 48) {
      value = b ^ c ^ d;
      word = (3 * index + 5) % 16;
    } else {
      value = c ^ (b | ~d);
      word = (7 * index) % 16;
    }
    const mixed = (value + a + MD5_CONSTANT[index] + block[word]) | 0;
    a = d;
    d = c;
    c = b;
    b = (b + ((mixed << MD5_SHIFT[index]) | (mixed >>> (32 - MD5_SHIFT[index])))) | 0;
  }
  state[0] = (state[0] + a) | 0;
  state[1] = (state[1] + b) | 0;
  state[2] = (state[2] + c) | 0;
  state[3] = (state[3] + d) | 0;
};

const md5Block = (value: string): number[] => {
  const block: number[] = [];
  for (let index = 0; index < 64; index += 4) {
    block[index >> 2] =
      value.charCodeAt(index) +
      (value.charCodeAt(index + 1) << 8) +
      (value.charCodeAt(index + 2) << 16) +
      (value.charCodeAt(index + 3) << 24);
  }
  return block;
};

export const md5 = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const state = [1732584193, -271733879, -1732584194, 271733878];
  let offset = 64;
  for (; offset <= binary.length; offset += 64) {
    md5Cycle(state, md5Block(binary.substring(offset - 64, offset)));
  }
  const rest = binary.substring(offset - 64);
  const tail = new Array<number>(16).fill(0);
  let index = 0;
  for (; index < rest.length; index += 1) {
    tail[index >> 2] |= rest.charCodeAt(index) << ((index % 4) << 3);
  }
  tail[index >> 2] |= 0x80 << ((index % 4) << 3);
  if (index > 55) {
    md5Cycle(state, tail);
    tail.fill(0);
  }
  tail[14] = binary.length * 8;
  md5Cycle(state, tail);
  const hex = '0123456789abcdef';
  return state
    .map((word) =>
      Array.from({ length: 4 }, (_, byte) =>
        `${hex[(word >> (byte * 8 + 4)) & 15]}${hex[(word >> (byte * 8)) & 15]}`,
      ).join(''),
    )
    .join('');
};

export const signAndroidLite = (
  params: Record<string, string | number>,
  body = '',
): string => {
  const query = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('');
  return md5(`${LITE_SALT}${query}${body}${LITE_SALT}`);
};

export const parseKugouResult = (payload: unknown): KugouApiResult => {
  const record = asRecord(payload);
  if (!record) {
    return { ok: false, code: -1, status: 0, message: '酷狗接口返回空响应', data: null, raw: payload };
  }
  const code = readNumber(record.error_code ?? record.err_code ?? record.errcode);
  const status = record.status === undefined ? 1 : readNumber(record.status);
  const ok = code === 0 && status !== 0 && record.success !== false;
  const message =
    readString(record.error_msg) ||
    readString(record.errmsg) ||
    readString(record.msg) ||
    readString(record.message) ||
    (ok ? '成功' : `酷狗接口错误 (${code ? `error_code: ${code}` : `status: ${status}`})`);
  return { ok, code, status, message, data: record.data ?? null, raw: payload };
};

const buildUrl = (baseUrl: string, path: string, params: Record<string, string | number>) => {
  const query = Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
  return `${baseUrl}${path}?${query}`;
};

export const createKugouClient = (ctx: EchoPluginContext): KugouClient => {
  const request = async (
    path: string,
    options: {
      baseUrl?: string;
      method?: 'GET' | 'POST';
      params?: Record<string, string | number>;
      body?: Record<string, unknown>;
      contentType?: string;
    } = {},
  ): Promise<KugouApiResult> => {
    const auth = getEchoKugouAuth(ctx);
    const clienttime = Math.floor(Date.now() / 1000);
    const params: Record<string, string | number> = {
      dfid: auth.dfid,
      mid: auth.mid,
      uuid: '-',
      appid: LITE_APP_ID,
      clientver: LITE_CLIENT_VERSION,
      clienttime,
      token: auth.token,
      userid: auth.userId,
      ...options.params,
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
        ...(options.contentType ? { 'Content-Type': options.contentType } : {}),
      },
      ...(options.body ? { body: options.body } : {}),
      responseType: 'json',
      timeoutMs: 20_000,
    });
    const result = parseKugouResult(response.data);
    return response.status >= 200 && response.status < 300
      ? result
      : { ...result, ok: false, message: result.message || `酷狗接口 HTTP ${response.status}` };
  };

  return {
    getAuth: () => getEchoKugouAuth(ctx),
    claimDayVip: (day) =>
      request('/youth/v1/recharge/receive_vip_listen_song', {
        method: 'POST',
        params: { source_id: 90139, receive_day: day },
        contentType: 'application/x-www-form-urlencoded',
      }),
    getMonthVipRecord: () =>
      request('/youth/v1/activity/get_month_vip_record', { params: { latest_limit: 100 } }),
    getUnionVip: () =>
      request('/v1/get_union_vip', {
        baseUrl: VIP_GATEWAY,
        params: { busi_type: 'concept', opt_product_types: 'dvip,qvip', product_type: 'svip' },
      }),
    upgradeDayVip: () =>
      request('/youth/v1/listen_song/upgrade_vip_reward', {
        method: 'POST',
        params: { kugouid: getEchoKugouAuth(ctx).userId, ad_type: 1 },
      }),
    reportAdPlay: (playStart, playEnd) =>
      request('/youth/v1/ad/play_report', {
        method: 'POST',
        body: { ad_id: 12307537187, play_start: playStart, play_end: playEnd },
        contentType: 'application/json; charset=utf-8',
      }),
  };
};
