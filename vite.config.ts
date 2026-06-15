import { defineConfig, type Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';

// ── Music index plugin ────────────────────────────────────────────────────────

interface FileEntry {
  name: string;    // display title (from XML or filename)
  path: string;    // path relative to Music/ root, e.g. "Subfolder/piece.xml"
  composer: string;
  staffs: number;  // 0 = unknown
}

interface DirEntry {
  name: string;    // folder display name
  path: string;    // path relative to Music/ root, e.g. "Subfolder"
  files: FileEntry[];
  dirs: DirEntry[];
}

interface MusicIndex {
  files: FileEntry[];
  dirs: DirEntry[];
}

function parseMeta(xmlText: string): { title: string; composer: string; staffs: number } {
  const title =
    xmlText.match(/<work-title>([\s\S]*?)<\/work-title>/)?.[1]?.trim() ||
    xmlText.match(/<movement-title>([\s\S]*?)<\/movement-title>/)?.[1]?.trim() ||
    '';
  const composer =
    xmlText.match(/<creator[^>]+type="composer"[^>]*>([\s\S]*?)<\/creator>/)?.[1]?.trim() ||
    xmlText.match(/<creator>([\s\S]*?)<\/creator>/)?.[1]?.trim() ||
    '';
  const staffs = (xmlText.match(/<score-part[\s>]/g) ?? []).length;
  return { title, composer, staffs };
}

function readXml(filePath: string): string | null {
  try {
    const buf = fs.readFileSync(filePath);
    if (filePath.toLowerCase().endsWith('.mxl')) {
      const files = unzipSync(buf);
      // MXL container: find rootfile path from META-INF/container.xml
      const containerKey = Object.keys(files).find(k => k === 'META-INF/container.xml');
      let xmlKey: string | undefined;
      if (containerKey) {
        const containerXml = strFromU8(files[containerKey]);
        xmlKey = containerXml.match(/full-path="([^"]+\.xml)"/)?.[1];
      }
      xmlKey ??= Object.keys(files).find(k => k.endsWith('.xml') && !k.startsWith('META-INF'));
      if (!xmlKey) return null;
      return strFromU8(files[xmlKey]);
    }
    return buf.toString('utf-8');
  } catch {
    return null;
  }
}

function scanDir(dir: string, relBase: string): { files: FileEntry[]; dirs: DirEntry[] } {
  const files: FileEntry[] = [];
  const dirs: DirEntry[] = [];

  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return { files, dirs }; }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    const absPath = path.join(dir, entry.name);
    const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      const sub = scanDir(absPath, relPath);
      if (sub.files.length > 0 || sub.dirs.length > 0) {
        dirs.push({ name: entry.name, path: relPath, ...sub });
      }
    } else if (/\.(xml|musicxml|mxl)$/i.test(entry.name)) {
      const xml = readXml(absPath);
      const meta = xml ? parseMeta(xml) : { title: '', composer: '', staffs: 0 };
      const baseName = entry.name.replace(/\.(xml|musicxml|mxl)$/i, '');
      files.push({
        name: meta.title || baseName,
        path: relPath,
        composer: meta.composer,
        staffs: meta.staffs,
      });
    }
  }
  return { files, dirs };
}

function buildMusicIndex(): Plugin {
  const musicDir = path.resolve(__dirname, 'public/Music');
  const outFile  = path.resolve(__dirname, 'src/music-index.json');

  function generate() {
    const index: MusicIndex = scanDir(musicDir, '');
    fs.writeFileSync(outFile, JSON.stringify(index, null, 2));
  }

  return {
    name: 'music-index',
    buildStart() { generate(); },
    configureServer(server) {
      generate();
      server.watcher.add(musicDir);
      server.watcher.on('all', (event, file) => {
        if (file.startsWith(musicDir) && file !== outFile) generate();
      });
    },
  };
}

// ── Vite config ───────────────────────────────────────────────────────────────

export default defineConfig({
  base: '/Plectra/',
  plugins: [buildMusicIndex()],
});
