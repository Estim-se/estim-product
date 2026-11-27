// estim Samtal: the test adapter. Reads calls from a folder outside the repository, so the whole chain can be run
// without a telephony provider. Each call is a metadata file <name>.json next to its recording <name>.<ext>:
//
//   { "call_id": "rollspel-01", "to": "070-111 11 11", "from": "+46 70 999 99 99",
//     "started_at": "2026-11-25T08:00:00+01:00", "ended_at": "2026-11-25T08:02:30+01:00" }
//
// "from" may be left out (withheld number); "duration_seconds" may replace "ended_at". The folder is the only
// thing read: a file name cannot point outside it, and audio larger than the bucket limit is refused.
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { SamtalAdapter } from './adapter';
import { SAMTAL_AUDIO_TYPES, SAMTAL_MAX_AUDIO_BYTES, standardCall, type SamtalCall } from './call';

const metadataSchema = z.object({
  call_id: z.string().trim().min(1).max(200), to: z.string().min(1).max(40), from: z.string().max(40).nullable().optional(),
  started_at: z.string().min(1).max(40), ended_at: z.string().max(40).nullable().optional(), duration_seconds: z.number().int().min(0).nullable().optional(),
}).passthrough();

export function folderAdapter(folder: string): SamtalAdapter {
  const root = resolve(folder);
  const inside = (path: string) => { const full = resolve(path); if (full !== root && !full.startsWith(root + sep)) throw new Error('outside_folder'); return full; };
  return {
    id: 'test',
    async receive() {
      const names = (await readdir(root)).sort();
      const calls: SamtalCall[] = [], rejected: { ref: string; code: string }[] = [];
      for (const name of names.filter(n => n.toLowerCase().endsWith('.json'))) {
        const stem = basename(name, extname(name));
        try {
          const meta = metadataSchema.parse(JSON.parse(await readFile(inside(join(root, name)), 'utf8')));
          const audio = names.find(n => n !== name && basename(n, extname(n)) === stem && SAMTAL_AUDIO_TYPES[extname(n).slice(1).toLowerCase()]);
          if (!audio) { rejected.push({ ref: stem, code: 'audio_missing' }); continue; }
          calls.push(standardCall({
            provider: 'test', provider_call_id: meta.call_id, to_phone: meta.to, from_phone: meta.from ?? null, started_at: meta.started_at,
            ended_at: meta.ended_at ?? null, duration_seconds: meta.duration_seconds ?? null,
            audio: { kind: 'file', path: inside(join(root, audio)), extension: extname(audio).slice(1).toLowerCase() },
          }));
        } catch (error) {
          rejected.push({ ref: stem, code: error instanceof SyntaxError ? 'invalid_json' : error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'invalid_metadata' });
        }
      }
      return { calls, rejected };
    },
    async openAudio(call) {
      if (call.provider !== 'test' || !call.audio || call.audio.kind !== 'file') throw new Error('not_a_test_call');
      const path = inside(call.audio.path);
      if ((await stat(path)).size > SAMTAL_MAX_AUDIO_BYTES) throw new Error('audio_too_large');
      return { bytes: new Uint8Array(await readFile(path)), contentType: SAMTAL_AUDIO_TYPES[call.audio.extension]!, extension: call.audio.extension };
    },
  };
}
