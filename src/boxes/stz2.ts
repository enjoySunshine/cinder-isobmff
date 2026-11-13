import { FullBox } from '#/box';
import type { MultiBufferStream } from '#/buffer';
import { Log } from '#/log';

export class stz2Box extends FullBox {
  static override readonly fourcc = 'stz2' as const;
  box_name = 'CompactSampleSizeBox' as const;

  sample_sizes: Array<number>;
  reserved: number;
  field_size: number;

  parse(stream: MultiBufferStream) {
    this.parseFullHeader(stream);
    this.sample_sizes = [];
    if (this.version === 0) {
      this.reserved = stream.readUint24();
      this.field_size = stream.readUint8();
      const sample_count = stream.readUint32();
      if (this.field_size === 4) {
        for (let i = 0; i < sample_count; i += 2) {
          const tmp = stream.readUint8();
          this.sample_sizes[i] = (tmp >> 4) & 0xf;
          this.sample_sizes[i + 1] = tmp & 0xf;
        }
      } else if (this.field_size === 8) {
        for (let i = 0; i < sample_count; i++) {
          this.sample_sizes[i] = stream.readUint8();
        }
      } else if (this.field_size === 16) {
        for (let i = 0; i < sample_count; i++) {
          this.sample_sizes[i] = stream.readUint16();
        }
      } else {
        Log.error('BoxParser', 'Error in length field in stz2 box', stream.isofile);
      }
    }
  }

  /** @bundle writing/stz2.js */
  write(stream: MultiBufferStream) {
    this.version = 0;
    this.flags = 0;
    const sample_count = this.sample_sizes ? this.sample_sizes.length : 0;
    this.size = 8; /* reserved(3) + field_size(1) + sample_count(4) */
    if (this.field_size === 4) {
      this.size += Math.ceil(sample_count / 2);
    } else if (this.field_size === 8) {
      this.size += sample_count;
    } else if (this.field_size === 16) {
      this.size += 2 * sample_count;
    }
    this.writeHeader(stream);
    stream.writeUint24(this.reserved ?? 0);
    stream.writeUint8(this.field_size);
    stream.writeUint32(sample_count);
    if (this.field_size === 4) {
      for (let i = 0; i < sample_count; i += 2) {
        stream.writeUint8(
          ((this.sample_sizes[i] & 0x0f) << 4) | ((this.sample_sizes[i + 1] ?? 0) & 0x0f),
        );
      }
    } else if (this.field_size === 8) {
      stream.writeUint8Array(this.sample_sizes);
    } else if (this.field_size === 16) {
      stream.writeUint16Array(this.sample_sizes);
    }
  }
}
