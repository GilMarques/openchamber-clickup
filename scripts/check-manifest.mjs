import { readFileSync } from 'node:fs';
import { parseManifest, parseManifestJson } from '@openchamber/sdk/schemas';
const raw = readFileSync('./package.json', 'utf8');
const result = parseManifestJson(raw);
console.log('ok:', result.ok);
console.log(JSON.stringify(result, null, 2).slice(0, 3000));
if (!result.ok) process.exit(1);
