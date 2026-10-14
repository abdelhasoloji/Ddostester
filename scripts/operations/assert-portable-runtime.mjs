import { readdir, open } from 'node:fs/promises';
import { join } from 'node:path';
const directory = process.argv[2];
if (!directory) throw new Error('Runtime dependency directory required');
async function inspect(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await inspect(child);
    else if (entry.isFile()) {
      if (/\.(node|so|dll|dylib)$/.test(entry.name))
        throw new Error('Native runtime addon requires a target-native dependency build');
      const file = await open(child, 'r');
      try {
        const bytes = Buffer.alloc(4);
        await file.read(bytes, 0, 4, 0);
        const magic = bytes.toString('hex');
        if (
          ['7f454c46', 'cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe'].includes(magic)
        )
          throw new Error('Native runtime executable requires a target-native dependency build');
      } finally {
        await file.close();
      }
    }
  }
}
await inspect(directory);
console.log('Runtime dependencies contain no native addons or executables');
