import { build } from '@sharkord/plugin-builder';
import fs from 'node:fs/promises';
import path from 'node:path';
import manifest from './manifest.json';

const pluginsPath = process.env.SHARKORD_PLUGINS_PATH;

const result = await build({
  sdkVersion: manifest.sdkVersion
});

if (pluginsPath) {
  const targetPath = path.join(pluginsPath, path.basename(result.outDir));

  await fs.rm(targetPath, { recursive: true, force: true });
  await fs.cp(result.outDir, targetPath, { recursive: true });

  console.log(`Copied the built plugin to ${targetPath}`);
}
