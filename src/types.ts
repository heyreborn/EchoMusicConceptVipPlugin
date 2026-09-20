export interface PluginSettings {
  autoClaim: boolean;
  autoUpgrade: boolean;
  notifySuccess: boolean;
}

export type ClaimStatusKind =
  | 'idle'
  | 'checking'
  | 'claiming'
  | 'upgrading'
  | 'claimed'
  | 'already-claimed'
  | 'upgraded'
  | 'partial'
  | 'error';

export interface ClaimStatus {
  kind: ClaimStatusKind;
  day: string;
  message: string;
  updatedAt: number;
}

export interface PluginState {
  settings: PluginSettings;
  status: ClaimStatus;
  monthRecord: unknown;
  vipDetail: unknown;
  refreshing: boolean;
}

export interface ClaimResult {
  ok: boolean;
  claimed: boolean;
  alreadyClaimed: boolean;
  upgraded: boolean;
  message: string;
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

export interface EchoPluginContext {
  id: string;
  manifest: { name?: string };
  vue: VueRuntime;
  kugou: {
    user: {
      claimDayVip(day: string): Promise<unknown>;
      upgradeDayVip(): Promise<unknown>;
      getVipMonthRecord(): Promise<unknown>;
      getUserVipDetail(): Promise<unknown>;
    };
  };
  storage: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
  };
  toast: {
    info(message: string): void;
    success(message: string): void;
    warning(message: string): void;
    danger(message: string): void;
  };
  ui: {
    components: Record<string, unknown>;
    settings: {
      define(options: Record<string, unknown>): (() => void) | void;
    };
    titlebar: {
      register(options: Record<string, unknown>): (() => void) | void;
    };
  };
  dispose(dispose: () => void): () => void;
}

export interface ClaimOptions {
  source?: 'manual' | 'auto';
}

export interface RefreshOptions {
  reportFailure?: boolean;
}

export interface VipService {
  claimToday(options?: ClaimOptions): Promise<ClaimResult>;
  upgrade(): Promise<ClaimResult>;
  refresh(options?: RefreshOptions): Promise<boolean>;
}
