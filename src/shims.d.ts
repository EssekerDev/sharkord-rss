// Minimal ambient declarations for the Sharkord SDK surface this plugin uses,
// plus rss-parser. The SDK package is provided by the host at runtime (and
// linked locally when building); these declarations keep `tsc` and tests
// working without cloning the whole Sharkord monorepo.

declare module '@sharkord/plugin-builder' {
  export function build(options: { sdkVersion: number }): Promise<{ outDir: string }>;
  export function publish(options: {
    githubToken?: string;
    repo: string;
    sdkVersion: number;
  }): Promise<{ releaseUrl: string }>;
}

declare module '@sharkord/plugin-sdk' {
  export const PLUGIN_SDK_VERSION: 2;

  export enum PluginSlot {
    CONNECT_SCREEN = 'connect_screen',
    HOME_SCREEN = 'home_screen',
    CHAT_ACTIONS = 'chat_actions',
    MESSAGE_ACTIONS = 'message_actions',
    MESSAGE_FOOTER = 'message_footer',
    MEMBER_LIST_ITEM = 'member_list_item',
    USER_POPOVER = 'user_popover',
    CHANNEL_HEADER = 'channel_header',
    TOPBAR_RIGHT = 'topbar_right',
    FULL_SCREEN = 'full_screen',
    USER_SETTINGS = 'user_settings'
  }

  export enum ChannelType {
    TEXT = 'TEXT',
    VOICE = 'VOICE'
  }

  export enum Permission {
    SEND_MESSAGES = 'SEND_MESSAGES',
    MANAGE_PLUGINS = 'MANAGE_PLUGINS',
    MANAGE_PLUGIN_PERMISSIONS = 'MANAGE_PLUGIN_PERMISSIONS',
    USE_PLUGINS = 'USE_PLUGINS'
  }

  export type TPluginComponentsMapBySlotId = {
    [slot in PluginSlot]?: React.ComponentType[];
  };

  export interface PluginSettings<
    T extends readonly { key: string; type: string; defaultValue: unknown }[]
  > {
    get<K extends T[number]['key']>(key: K): unknown;
    set<K extends T[number]['key']>(key: K, value: unknown): void;
  }

  export type TChannel = {
    id: number;
    name: string;
    type: ChannelType | string;
    categoryId?: number | null;
  };

  export type TInvokerContext = {
    userId: number;
    source: 'chat' | 'api';
    channelId?: number;
  };

  export type TPluginContract = {
    actions?: Record<string, { payload: unknown; response: unknown }>;
    commands?: Record<string, { args: unknown; response: unknown }>;
  };

  type TContractActions<C> = C extends { actions: infer A }
    ? A
    : Record<string, { payload: unknown; response: unknown }>;

  export type TUpgradeInfo = {
    previousVersion: string;
    version: string;
  };

  export interface PluginContext<C extends TPluginContract = TPluginContract> {
    path: string;
    dataPath: string;
    pluginId: string;
    logger: {
      log: (...args: unknown[]) => void;
      debug: (...args: unknown[]) => void;
      error: (...args: unknown[]) => void;
    };
    log: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    events: {
      on: (
        event: string,
        handler: (payload: {
          pluginId?: string;
          key?: string;
          value?: unknown;
          channelId?: number;
        }) => void | Promise<void>
      ) => () => void;
      off: (
        event: string,
        handler: (payload: unknown) => void | Promise<void>
      ) => void;
    };
    messages: {
      send: (
        channelId: number,
        content: string,
        options?: { previews?: boolean }
      ) => Promise<{ messageId: number }>;
      edit: (messageId: number, content: string) => Promise<void>;
      delete: (messageId: number) => Promise<void>;
    };
    settings: {
      register: <
        T extends readonly { key: string; type: string; defaultValue: unknown }[]
      >(
        definitions: T
      ) => Promise<PluginSettings<T>>;
    };
    channels: {
      list: () => Promise<TChannel[]>;
      get: (channelId: number) => Promise<TChannel | undefined>;
    };
    permissions: {
      userCan: (userId: number, permission: Permission) => Promise<boolean>;
    };
    actions: {
      register: <K extends keyof TContractActions<C> & string>(action: {
        name: K;
        description?: string;
        requires?: Permission;
        executes: (
          invoker: TInvokerContext,
          payload: TContractActions<C>[K]['payload']
        ) => Promise<TContractActions<C>[K]['response']>;
      }) => void;
    };
    commands: {
      register: (command: {
        name: string;
        description?: string;
        requires?: Permission;
        executes: (invoker: TInvokerContext, args: unknown) => Promise<unknown>;
      }) => void;
    };
    ui: {
      enable: () => void;
      disable: () => void;
    };
  }

  export type UnloadPluginContext = Pick<
    PluginContext,
    'path' | 'dataPath' | 'logger' | 'log' | 'debug' | 'error' | 'messages' | 'ui'
  >;

  export type UpgradePluginContext = Pick<
    PluginContext,
    'pluginId' | 'path' | 'dataPath' | 'logger' | 'log' | 'debug' | 'error'
  >;
}

declare module 'rss-parser' {
  export default class Parser<
    TFeed = Record<string, unknown>,
    TItem = Record<string, unknown>
  > {
    public constructor(options?: unknown);
    public parseURL(url: string): Promise<TFeed & { items?: TItem[] }>;
    public parseString(xml: string): Promise<TFeed & { items?: TItem[] }>;
  }
}
