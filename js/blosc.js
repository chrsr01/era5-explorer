// Decoder for Blosc 1 containers holding LZ4 blocks with optional byte shuffle: the
// compression of every array in the two ERA5 Zarr stores. Other Blosc codecs, and
// bit shuffle, are rejected rather than guessed at.

/** Decompress one Blosc chunk (Uint8Array) into a new Uint8Array. */
export function bloscDecode(src) {
  const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const flags = src[2];
  const typesize = src[3];
  const nbytes = view.getInt32(4, true);
  const blocksize = view.getInt32(8, true);
  if (view.getInt32(12, true) !== src.length) throw new Error("blosc: truncated chunk");
  const out = new Uint8Array(nbytes);
  if (flags & 0x02) {  // stored uncompressed
    out.set(src.subarray(16, 16 + nbytes));
    return out;
  }
  if (flags >> 5 !== 1) throw new Error("blosc: only LZ4 is supported");
  if (flags & 0x04) throw new Error("blosc: bit shuffle is not supported");
  const shuffled = (flags & 0x01) !== 0 && typesize > 1;
  const maySplit = !(flags & 0x10) && typesize <= 16;
  const tmp = shuffled ? new Uint8Array(blocksize) : null;

  const nblocks = Math.ceil(nbytes / blocksize);
  for (let b = 0; b < nblocks; b++) {
    const start = b * blocksize;
    const size = Math.min(blocksize, nbytes - start);
    // A full block is stored as one stream per byte of the element type.
    const nstreams = maySplit && size === blocksize && size / typesize >= 128 ? typesize : 1;
    const streamSize = size / nstreams;
    const dst = shuffled ? tmp : out;
    let d = shuffled ? 0 : start;
    let s = view.getInt32(16 + 4 * b, true);
    for (let k = 0; k < nstreams; k++) {
      const csize = view.getInt32(s, true);
      s += 4;
      if (csize === streamSize) dst.set(src.subarray(s, s + csize), d);
      else lz4Block(src, s, s + csize, dst, d, d + streamSize);
      s += csize;
      d += streamSize;
    }
    if (shuffled) unshuffle(tmp, out, start, size, typesize);
  }
  return out;
}

function lz4Block(src, s, sEnd, dst, d, dEnd) {
  while (s < sEnd) {
    const token = src[s++];
    let literals = token >> 4;
    if (literals === 15) {
      let b;
      do { b = src[s++]; literals += b; } while (b === 255);
    }
    if (literals > 24) dst.set(src.subarray(s, s + literals), d);
    else for (let i = 0; i < literals; i++) dst[d + i] = src[s + i];
    s += literals;
    d += literals;
    if (s >= sEnd) break;  // the last sequence has no match

    const offset = src[s] | (src[s + 1] << 8);
    s += 2;
    let length = (token & 15) + 4;
    if (length === 19) {
      let b;
      do { b = src[s++]; length += b; } while (b === 255);
    }
    if (offset === 0 || offset > d || d + length > dEnd) throw new Error("blosc: corrupt LZ4 block");
    const from = d - offset;
    if (offset >= length && length > 24) dst.copyWithin(d, from, from + length);
    else for (let i = 0; i < length; i++) dst[d + i] = dst[from + i];  // may overlap: byte by byte
    d += length;
  }
  if (d !== dEnd) throw new Error("blosc: corrupt LZ4 block");
}

/** Undo the byte shuffle: tmp holds all first bytes, then all second bytes, ... */
function unshuffle(tmp, out, start, size, typesize) {
  const n = Math.floor(size / typesize);
  for (let j = 0; j < typesize; j++) {
    const plane = j * n;
    for (let i = 0, o = start + j; i < n; i++, o += typesize) out[o] = tmp[plane + i];
  }
  for (let i = n * typesize; i < size; i++) out[start + i] = tmp[i];
}
