import { build } from '@sharkord/plugin-builder';
import manifest from './manifest.json';

// Use Sharkord's official builder so local builds and marketplace publication
// follow the same bundle, archive, and version-file pipeline.
await build({
  sdkVersion: manifest.sdkVersion
});
