import type { ComponentType } from 'react';
import type { TPluginComponentsMapBySlotId } from '@sharkord/plugin-sdk';
import { Feeds } from './feeds';

type TPluginTabs = Array<{
  id: string;
  label: string;
  component: ComponentType;
}>;

// No chat or home-screen UI: members never see this plugin. The Feeds tab
// is added to the plugin's own page in server settings, which only someone
// who can manage plugins can open.
const components: TPluginComponentsMapBySlotId = {};

const tabs: TPluginTabs = [{ id: 'feeds', label: 'Feeds', component: Feeds }];

export { components, tabs };
