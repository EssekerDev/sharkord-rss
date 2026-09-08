import { useSyncExternalStore } from 'react';
import type { TPlugin } from '../types';

type TChannel = { id: number; name: string; type: string };

type TPluginStore = {
  subscribe: (listener: () => void) => () => void;
  getState: () => { channels: TChannel[] };
  actions: {
    executePluginAction: (
      pluginId: string,
      name: string,
      payload: unknown
    ) => Promise<unknown>;
  };
};

const PLUGIN_ID = 'sharkord-rss';

const store = (): TPluginStore => {
  const host = window as unknown as { __SHARKORD_STORE__?: TPluginStore };
  if (!host.__SHARKORD_STORE__) {
    throw new Error('Sharkord client store is not available.');
  }
  return host.__SHARKORD_STORE__;
};

const callAction = <K extends keyof TPlugin['actions'] & string>(
  name: K,
  payload: TPlugin['actions'][K]['payload']
): Promise<TPlugin['actions'][K]['response']> =>
  store().actions.executePluginAction(PLUGIN_ID, name, payload) as Promise<
    TPlugin['actions'][K]['response']
  >;

const useStoreSelector = <T>(selector: (state: { channels: TChannel[] }) => T): T =>
  useSyncExternalStore(
    (listener) => store().subscribe(listener),
    () => selector(store().getState())
  );

export { callAction, useStoreSelector };
export type { TChannel };
