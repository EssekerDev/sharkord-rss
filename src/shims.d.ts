// Minimal ambient declarations for the Sharkord SDK surface this plugin uses,
// plus the rss-parser library. The plugin only depends on the SDK types (the
// package itself is provided by the host at runtime), so we declare just what
// the server and client entry points reference.
declare module '@sharkord/plugin-sdk' {
  export enum PluginSlot {
    CONNECT_SCREEN = 'connect_screen',
    HOME_SCREEN = 'home_screen',
    CHAT_ACTIONS = 'chat_actions',
    TOPBAR_RIGHT = 'topbar_right',
    FULL_SCREEN = 'full_screen'
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

  export type PluginContext = {
    path: string;
    pluginId: string;
    log: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    events: {
      on: (
        event: 'setting:set',
        handler: (payload: {
          pluginId?: string;
          key: string;
          value: unknown;
        }) => void | Promise<void>
      ) => () => void;
      off: (
        event: 'setting:set',
        handler: (payload: {
          pluginId?: string;
          key: string;
          value: unknown;
        }) => void | Promise<void>
      ) => void;
    };
    messages: {
      send: (channelId: number, content: string) => Promise<{ messageId: number }>;
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
    data: {
      getChannel: (channelId: number) => Promise<unknown | undefined>;
    };
  };
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
