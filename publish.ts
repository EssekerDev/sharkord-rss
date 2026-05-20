import { publish } from '@sharkord/plugin-builder';
import manifest from './manifest.json';

const repo = process.env.PLUGIN_REPOSITORY || process.env.GITHUB_REPOSITORY;

if (!repo) {
  throw new Error(
    'Set PLUGIN_REPOSITORY to your public GitHub repository, for example "EssekerDev/sharkord-rss".'
  );
}

const result = await publish({
  githubToken: process.env.GITHUB_TOKEN,
  repo,
  sdkVersion: manifest.sdkVersion
});

console.log('Plugin published successfully', result.releaseUrl);
