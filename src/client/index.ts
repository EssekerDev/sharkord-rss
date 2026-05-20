import type { TPluginComponentsMapBySlotId } from '@sharkord/plugin-sdk';

// This plugin is configured entirely from the admin-only plugin settings dialog
// (Server Settings -> Extensions). It does not register any client components,
// so no buttons, pages, or chat UI are added for regular members.
const components: TPluginComponentsMapBySlotId = {};

export { components };
