// estim Samtal: the interface every telephony adapter implements. The processing (registration, speech to text,
// classification, extraction, inbox) is the same for all adapters and only sees standard calls and audio bytes.
// A provider (Lynes, Telavox, Telia Touchpoint, 46elks) is added as one new adapter, without changes elsewhere.
import type { SamtalCall } from './call';

export interface SamtalAudio { bytes: Uint8Array; contentType: string; extension: string }

export interface SamtalAdapter {
  // Stable id, stored as samtal_calls.provider (part of the duplicate key provider + provider_call_id).
  readonly id: string;
  // Turns what the provider delivered (a webhook body, a folder …) into standard calls. Invalid entries are skipped
  // and reported by code only, never with call contents.
  receive(input: unknown): Promise<{ calls: SamtalCall[]; rejected: { ref: string; code: string }[] }>;
  // Reads the recording of one of its own calls (bounded by SAMTAL_MAX_AUDIO_BYTES).
  openAudio(call: SamtalCall): Promise<SamtalAudio>;
}
