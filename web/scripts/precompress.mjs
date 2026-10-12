import { readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';

const compressBrotli = promisify(brotliCompress);
const compressGzip = promisify(gzip);
const dist = fileURLToPath(new URL('../dist/', import.meta.url));

// Compress once at build time instead of spending CPU on each HTTP request.
// Keep originals for clients without compression and for Vite's preview server.
for (const entry of await readdir(dist, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !/\.(?:html|js|css|svg)$/.test(entry.name)) continue;
  const filename = path.join(entry.parentPath, entry.name);
  const content = await readFile(filename);
  const [br, gz] = await Promise.all([
    compressBrotli(content, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } }),
    compressGzip(content, { level: 9 }),
  ]);
  await Promise.all([
    writeFile(`${filename}.br`, br),
    writeFile(`${filename}.gz`, gz),
  ]);
}
