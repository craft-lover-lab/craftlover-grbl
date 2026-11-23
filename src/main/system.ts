import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Tìm Ghostscript (gswin64c.exe) trong Program Files hoặc PATH. */
export function findGhostscript(): string | null {
  for (const root of [process.env['ProgramFiles'], process.env['ProgramFiles(x86)']]) {
    if (!root) continue;
    const gsDir = path.join(root, 'gs');
    if (!existsSync(gsDir)) continue;
    // Chọn bản mới nhất (tên thư mục dạng gs10.04.0)
    const versions = readdirSync(gsDir).sort().reverse();
    for (const v of versions)
      for (const exe of ['gswin64c.exe', 'gswin32c.exe']) {
        const p = path.join(gsDir, v, 'bin', exe);
        if (existsSync(p)) return p;
      }
  }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter))
    for (const exe of ['gswin64c.exe', 'gswin32c.exe', 'gs']) {
      const p = path.join(dir, exe);
      if (existsSync(p)) return p;
    }
  return null;
}

/** Chuyển EPS → PDF bằng Ghostscript (giữ nguyên vector, cắt sát khung bao). */
export async function epsToPdf(data: Uint8Array): Promise<Uint8Array> {
  const gs = findGhostscript();
  if (!gs)
    throw new Error(
      'Cần cài Ghostscript để mở file EPS.\nTải bản miễn phí tại https://ghostscript.com/releases/gsdnld.html (chọn bản 64-bit cho Windows), cài xong mở lại phần mềm.',
    );
  const dir = await mkdtemp(path.join(os.tmpdir(), 'laser-eps-'));
  try {
    const src = path.join(dir, 'in.eps');
    const dst = path.join(dir, 'out.pdf');
    await writeFile(src, data);
    // -dSAFER: chặn file EPS truy cập hệ thống; -dNOCACHE giữ chữ dạng đường cong
    await run(gs, ['-dSAFER', '-dBATCH', '-dNOPAUSE', '-dQUIET', '-dEPSCrop', '-dNOCACHE', '-sDEVICE=pdfwrite', `-sOutputFile=${dst}`, src], {
      timeout: 60000,
      windowsHide: true,
    });
    return new Uint8Array(await readFile(dst));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface FontEntry {
  name: string;
  file: string;
}

/** Danh sách font đã cài trên Windows (đọc từ registry của máy và của người dùng). */
export async function listFonts(): Promise<FontEntry[]> {
  const sysDir = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts');
  const keys = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
    'HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
  ];
  const out = new Map<string, FontEntry>();
  for (const key of keys) {
    try {
      const { stdout } = await run('reg', ['query', key], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
      for (const line of stdout.split(/\r?\n/)) {
        const m = line.match(/^\s+(.+?)\s+REG_SZ\s+(.+)$/);
        if (!m) continue;
        const file = path.isAbsolute(m[2]) ? m[2] : path.join(sysDir, m[2]);
        // Bỏ các font dạng collection/bitmap mà opentype.js không đọc được
        if (!/\.(ttf|otf)$/i.test(file)) continue;
        const name = m[1].replace(/\s*\((TrueType|OpenType)\)$/i, '');
        out.set(name, { name, file });
      }
    } catch {
      /* khóa không tồn tại */
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function readFont(file: string, allowed: FontEntry[]): Promise<Uint8Array> {
  // Chỉ cho đọc file nằm trong danh sách font đã liệt kê
  const norm = (f: string) => path.resolve(f).toLowerCase();
  if (!allowed.some((f) => norm(f.file) === norm(file))) throw new Error('Font không hợp lệ');
  return new Uint8Array(await readFile(file));
}
