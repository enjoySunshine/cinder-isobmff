import fs from 'fs';
import path from 'path';
import files from '../.cache/files.json';
import { createFile, MP4BoxBuffer, type ISOFile, type Sample } from '../entries/all';

/**
 * Segmentation round-trip validation.
 *
 * Every self-contained published file up to 8 MB is:
 *  1. parsed and its samples read back (dts, cts, duration, sync flag and data digest)
 *     through the regular sample access interfaces;
 *  2. re-fragmented with initializeSegmentation/onSegment (20 samples per segment);
 *  3. rebuilt by concatenating the init segment and all media segments, parsed again
 *     and read back a second time.
 *
 * Both reads must yield the exact same samples, and the init segment alone must not
 * contain any sample (no leftover sample table information).
 *
 * Files whose media data is not fully contained in the file itself are out of scope:
 * their samples cannot be extracted in the first place. This covers files referencing
 * external media data through their data references (e.g. isobmff/a6_tone_multifile.mp4)
 * as well as files with truncated media data.
 */

const publishedPrefix = 'published/';
const MAX_FILE_SIZE = 8 * 1024 * 1024;
const NB_SAMPLES_PER_SEGMENT = 20;

// Regression coverage for files that used to fail this round-trip:
// - isobmff/17_negative_ctso.mp4 and nalu/hevc/hvc2_extractors.mp4: negative
//   composition time offsets were written as unsigned values in trun boxes
// - isobmff/a7-tone-oddities.mp4: the stz2 sample table was copied verbatim into
//   the init segment, creating ghost samples when re-parsing
const COVERED_REGRESSION_FILES = [
  'isobmff/17_negative_ctso.mp4',
  'isobmff/a7-tone-oddities.mp4',
  'nalu/hevc/hvc2_extractors.mp4',
];

const corpus: Array<string> = [];
Object.values(files.file_metadata).forEach(meta => {
  if (!meta.published) return;
  const filePath = path.join(import.meta.dirname, '..', '.cache', 'files', meta.abs_filepath);
  if (!fs.existsSync(filePath) || filePath.endsWith('.zip')) return;
  if (fs.statSync(filePath).size > MAX_FILE_SIZE) return;
  corpus.push(meta.abs_filepath.slice(publishedPrefix.length));
});
corpus.sort();

function loadFile(filePath: string): ISOFile {
  const mp4 = createFile(true);
  const data = fs.readFileSync(filePath);
  const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  mp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(ab, 0));
  mp4.flush();
  return mp4;
}

function fnv1a(data: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    hash ^= data[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

interface SampleSignature {
  dts: number;
  cts: number;
  duration: number;
  is_sync: boolean;
  size: number;
  digest?: string;
}

function getSampleSignatures(mp4: ISOFile, trackId: number): Array<SampleSignature> {
  const samples = mp4.getTrackSamplesInfo(trackId) ?? [];
  return samples.map((sample: Sample, index: number) => {
    const fullSample = mp4.getTrackSample(trackId, index);
    return {
      dts: sample.dts,
      cts: sample.cts,
      duration: sample.duration,
      is_sync: sample.is_sync,
      size: sample.size,
      digest: fullSample?.data ? fnv1a(fullSample.data) : undefined,
    };
  });
}

/** A missing digest means the sample data could not be extracted from the file */
function hasAllSampleData(signatures: Record<number, Array<SampleSignature>>): boolean {
  return Object.values(signatures).every(sigs => sigs.every(sig => sig.digest !== undefined));
}

function segmentFile(mp4: ISOFile, trackIds: Array<number>) {
  const segments: Array<Uint8Array> = [];
  for (const id of trackIds) {
    mp4.setSegmentOptions(id, undefined, {
      nbSamples: NB_SAMPLES_PER_SEGMENT,
      rapAlignement: false,
    });
  }
  mp4.onSegment = (_id, _user, buffer) => {
    segments.push(new Uint8Array(buffer));
  };
  const init = mp4.initializeSegmentation();
  mp4.start();
  return { init: init.buffer, segments };
}

function concatenate(init: ArrayBuffer, segments: Array<Uint8Array>): ArrayBuffer {
  const totalLength = init.byteLength + segments.reduce((sum, s) => sum + s.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  result.set(new Uint8Array(init), offset);
  offset += init.byteLength;
  for (const segment of segments) {
    result.set(segment, offset);
    offset += segment.byteLength;
  }
  return result.buffer;
}

describe('Segmentation round-trip', () => {
  it('covers the files that used to fail the round-trip', () => {
    for (const name of COVERED_REGRESSION_FILES) {
      expect(corpus).toContain(name);
    }
  });

  it('excludes files whose samples cannot be extracted (e.g. isobmff/a6_tone_multifile.mp4)', () => {
    // a6_tone_multifile.mp4 keeps its media data in an external file (see its dref box),
    // so its samples cannot be extracted from the file itself
    const filePath = path.join(
      import.meta.dirname,
      '..',
      '.cache',
      'files',
      publishedPrefix,
      'isobmff/a6_tone_multifile.mp4',
    );
    const mp4 = loadFile(filePath);
    const signatures: Record<number, Array<SampleSignature>> = {};
    for (const track of mp4.getInfo().tracks) {
      signatures[track.id] = getSampleSignatures(mp4, track.id);
    }
    expect(hasAllSampleData(signatures)).toBe(false);
  });

  test.for(corpus)('%s', { timeout: 60_000 }, (testName, { skip }) => {
    const filePath = path.join(
      import.meta.dirname,
      '..',
      '.cache',
      'files',
      publishedPrefix,
      testName,
    );

    const mp4 = loadFile(filePath);
    const info = mp4.getInfo();
    if (!info.hasMoov || info.tracks.length === 0) skip();

    // Reference samples, read through the sample access interfaces
    const trackIds = info.tracks.map(track => track.id);
    const expected: Record<number, Array<SampleSignature>> = {};
    for (const id of trackIds) {
      expected[id] = getSampleSignatures(mp4, id);
    }
    // Files whose sample data is not fully available cannot be round-tripped
    if (!hasAllSampleData(expected)) skip();

    // Re-fragment the file from a fresh parse
    const segmentingMp4 = loadFile(filePath);
    const { init, segments } = segmentFile(segmentingMp4, trackIds);

    // The init segment alone must not contain any sample
    const initMp4 = createFile(true);
    initMp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(init, 0));
    initMp4.flush();
    for (const track of initMp4.getInfo().tracks) {
      expect(initMp4.getTrackSamplesInfo(track.id) ?? []).toEqual([]);
    }

    // Re-parse init + media segments and read the samples back
    const reparsedMp4 = createFile(true);
    reparsedMp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(concatenate(init, segments), 0));
    reparsedMp4.flush();

    const reparsedInfo = reparsedMp4.getInfo();
    expect(reparsedInfo.tracks.map(track => track.id)).toEqual(trackIds);
    for (const id of trackIds) {
      expect(getSampleSignatures(reparsedMp4, id)).toEqual(expected[id]);
    }
  });
});
