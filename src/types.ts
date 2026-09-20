export interface PluginSettings {
  autoClaim: boolean;
  autoUpgrade: boolean;
  notifySuccess: boolean;
  futureDays: number;
  delaySeconds: number;
  adEnabled: boolean;
  adCount: number;
  receiveDay: string;
}

export type ClaimStatusKind =
  | 'idle'
  | 'checking'
  | 'claiming'
  | 'advertising'
  | 'upgrading'
  | 'claimed'
  | 'already-claimed'
  | 'upgraded'
  | 'partial'
  | 'canceled'
  | 'error';

export interface ClaimStatus {
  kind: ClaimStatusKind;
  day: string;
  message: string;
  updatedAt: number;
}

export interface DateTaskRecord {
  ok: boolean;
  already?: boolean;
  message: string;
  updatedAt: number;
}

export interface HistoryEntry {
  id: string;
  source: 'manual' | 'auto';
  startedAt: number;
  finishedAt: number;
  ok: boolean;
  message: string;
}

export interface PersistedState {
  claimedDates: Record<string, DateTaskRecord>;
  upgradeDates: Record<string, DateTaskRecord>;
  adTaskDates: Record<string, { done: number; message: string; updatedAt: number }>;
  history: HistoryEntry[];
  lastResult: string;
}

export interface TaskProgress {
  phase: 'idle' | 'claim' | 'ad' | 'upgrade' | 'refresh';
  current: number;
  total: number;
  label: string;
}

export interface PluginState {
  settings: PluginSettings;
  persisted: PersistedState;
  status: ClaimStatus;
  monthRecord: unknown;
  vipDetail: unknown;
  vipText: string;
  running: boolean;
  cancelRequested: boolean;
  progress: TaskProgress;
}

export interface ClaimResult {
  ok: boolean;
  claimed: boolean;
  alreadyClaimed: boolean;
  upgraded: boolean;
  canceled?: boolean;
  message: string;
}

export interface KugouAuth {
  token: string;
  userId: number;
  mid: string;
  dfid: string;
  uuid: string;
}

export interface KugouApiResult {
  ok: boolean;
  code: number;
  status: number;
  message: string;
  data: unknown;
  raw: unknown;
}

export interface KugouClient {
  getAuth(): KugouAuth;
  claimDayVip(day: string): Promise<KugouApiResult>;
  getMonthVipRecord(): Promise<KugouApiResult>;
  getUnionVip(): Promise<KugouApiResult>;
  upgradeDayVip(): Promise<KugouApiResult>;
  reportAdPlay(playStart: number, playEnd: number): Promise<KugouApiResult>;
}

export interface VueRef<T> {
  value: T;
}

export interface VueRuntime {
  reactive<T extends object>(value: T): T;
  ref<T>(value: T): VueRef<T>;
  computed<T>(getter: () => T): Readonly<VueRef<T>>;
  defineComponent(options: Record<string, unknown>): unknown;
  defineAsyncComponent(loader: unknown): unknown;
  h(type: unknown, propsOrChildren?: unknown, children?: unknown): unknown;
  onMounted(callback: () => void): void;
}

export interface PluginNetworkResponse<T = unknown> {
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string | string[]>;
  data: T;
}

export interface EchoPluginContext {
  id: string;
  manifest: { name?: string };
  vue: VueRuntime;
  pinia: { state: VueRef<Record<string, unknown>> };
  net: {
    request<T = unknown>(options: {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: unknown;
      responseType?: 'json' | 'text' | 'arrayBuffer';
      timeoutMs?: number;
    }): Promise<PluginNetworkResponse<T>>;
  };
  storage: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    delete?(key: string): Promise<void>;
  };
  toast: {
    info(message: string): void;
    success(message: string): void;
    warning(message: string): void;
    danger(message: string): void;
  };
  ui: {
    components: Record<string, unknown>;
    settings: { define(options: Record<string, unknown>): (() => void) | void };
    titlebar: { register(options: Record<string, unknown>): (() => void) | void };
  };
  dispose(dispose: () => void): () => void;
}

export interface RunOptions {
  source?: 'manual' | 'auto';
  force?: boolean;
  includeAds?: boolean;
  includeUpgrade?: boolean;
}

export interface RefreshOptions {
  reportFailure?: boolean;
}

export interface VipService {
  runAll(options?: RunOptions): Promise<ClaimResult>;
  claimConfigured(options?: RunOptions): Promise<ClaimResult>;
  claimToday(options?: RunOptions): Promise<ClaimResult>;
  upgrade(options?: RunOptions): Promise<ClaimResult>;
  runAds(options?: RunOptions): Promise<ClaimResult>;
  refresh(options?: RefreshOptions): Promise<boolean>;
  cancel(): void;
}
