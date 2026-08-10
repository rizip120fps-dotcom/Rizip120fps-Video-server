// MP4 audio-fake patch engine — faithful port of the working Chrome extension.
// Patches audio track metadata with phantom samples to prevent TikTok compression/hiding.

const FAKE_SAMPLE = Buffer.from([0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00]);
const FAKE_PER_REAL = 9;

// ─── Byte helpers ───────────────────────────────────────────────────────────
function readU32(b, o) { return b.readUInt32BE(o); }
function readU64(b, o) { return b.readUInt32BE(o) * 4294967296 + b.readUInt32BE(o + 4); }
function writeU32(b, o, v) { b.writeUInt32BE(v >>> 0, o); }
function writeU64(b, o, v) { const hi = Math.floor(v / 4294967296); writeU32(b, o, hi); writeU32(b, o + 4, (v - hi * 4294967296) >>> 0); }

// ─── MP4 box helpers (all offsets relative to buffer start = offset 0) ──────
function typeAt(b, o) { return b.toString('ascii', o, o + 4); }
function boxType(b) { return typeAt(b, 4); }
function headerSize(b) { return readU32(b, 0) === 1 ? 16 : 8; }
function boxSize(b, o) { return readU32(b, o) === 1 ? readU64(b, o + 8) : readU32(b, o); }
function childStart(b) {
  const h = headerSize(b);
  return boxType(b) === 'meta' ? h + 4 : h;
}

function parseBoxes(bytes, start, end) {
  const out = [];
  let pos = start;
  while (pos + 8 <= end) {
    const sz = boxSize(bytes, pos);
    if (sz < 8 || pos + sz > end) break;
    out.push({ type: typeAt(bytes, pos + 4), start: pos, end: pos + sz, size: sz, header: readU32(bytes, pos) === 1 ? 16 : 8 });
    pos += sz;
  }
  return out;
}

function makeBox(type, payload, large) {
  const h = large ? 16 : 8;
  const out = Buffer.alloc(h + payload.length);
  if (large) { writeU32(out, 0, 1); out.write(type, 4, 'ascii'); writeU64(out, 8, h + payload.length); payload.copy(out, 16); }
  else { writeU32(out, 0, h + payload.length); out.write(type, 4, 'ascii'); payload.copy(out, 8); }
  return out;
}

function concat(buffers) {
  let total = 0;
  for (const b of buffers) total += b.length;
  const out = Buffer.alloc(total);
  let off = 0;
  for (const b of buffers) { b.copy(out, off); off += b.length; }
  return out;
}

function findPath(box, path) {
  let cur = box;
  for (const t of path) { cur = findChild(cur, t); if (!cur) return null; }
  return cur;
}

function findChild(box, type) {
  const s = childStart(box);
  for (const b of parseBoxes(box, s, box.length)) {
    if (b.type === type) return box.slice(b.start, b.end);
  }
  return null;
}

function handlerType(trak) {
  const hdlr = findPath(trak, ['mdia', 'hdlr']);
  if (!hdlr) return '';
  return typeAt(hdlr, headerSize(hdlr) + 8);
}

// ─── rebuildContainer — exact copy from extension ───────────────────────────
function rebuildContainer(box, mapChild) {
  const t = boxType(box), h = headerSize(box), cs = childStart(box);
  const prefix = box.slice(h, cs);
  const parts = [prefix];
  for (const b of parseBoxes(box, cs, box.length)) {
    const child = box.slice(b.start, b.end);
    const mapped = mapChild(child, b.type);
    if (mapped !== null && mapped !== undefined) parts.push(mapped);
  }
  return makeBox(t, concat(parts), h === 16);
}

// ─── Audio trak patching ────────────────────────────────────────────────────
function patchAudioStsz(stsz, fakeCount) {
  const h = headerSize(stsz);
  const oldCount = readU32(stsz, h + 8);
  const oldPayload = stsz.slice(h);
  const payload = Buffer.alloc(oldPayload.length + fakeCount * 4);
  oldPayload.copy(payload);
  writeU32(payload, 8, oldCount + fakeCount);
  let o = oldPayload.length;
  for (let i = 0; i < fakeCount; i++, o += 4) writeU32(payload, o, FAKE_SAMPLE.length);
  return makeBox('stsz', payload, h === 16);
}

function patchAudioStsc(stsc, origStcoCount, fakeCount) {
  const h = headerSize(stsc);
  const oldN = readU32(stsc, h + 4);
  const oldPayload = stsc.slice(h);
  const payload = Buffer.alloc(oldPayload.length + 12);
  oldPayload.copy(payload);
  writeU32(payload, 4, oldN + 1);
  const o = oldPayload.length;
  writeU32(payload, o, origStcoCount + 1);
  writeU32(payload, o + 4, fakeCount);
  writeU32(payload, o + 8, 1);
  return makeBox('stsc', payload, h === 16);
}

function patchAudioStco(stco, fakeOffset, shift) {
  const t = boxType(stco), step = t === 'co64' ? 8 : 4;
  const h = headerSize(stco);
  const n = readU32(stco, h + 4);
  const payload = Buffer.alloc(8 + (n + 1) * step);
  writeU32(payload, 4, n + 1);
  for (let i = 0; i < n; i++) {
    const off = h + 8 + i * step;
    const val = step === 8 ? readU64(stco, off) : readU32(stco, off);
    const nv = val + shift;
    if (step === 8) writeU64(payload, 8 + i * step, nv); else writeU32(payload, 8 + i * step, nv);
  }
  const lastOff = 8 + n * step;
  if (step === 8) writeU64(payload, lastOff, fakeOffset); else writeU32(payload, lastOff, fakeOffset);
  return makeBox(t, payload, h === 16);
}

function makeAudioTrak(origTrak, fakeCount, fakeOffset, stcoShift) {
  stcoShift = stcoShift || 0;
  const origStbl = findPath(origTrak, ['mdia', 'minf', 'stbl']);
  const origStco = findChild(origStbl, 'stco') || findChild(origStbl, 'co64');
  const origStcoCount = origStco ? readU32(origStco, headerSize(origStco) + 4) : 0;

  return rebuildContainer(origTrak, (child, t) => {
    if (t === 'edts') return null;
    if (t !== 'mdia') return child;
    return rebuildContainer(child, (c2, t2) => {
      if (t2 !== 'minf') return c2;
      return rebuildContainer(c2, (c3, t3) => {
        if (t3 !== 'stbl') return c3;
        return rebuildContainer(c3, (c4, t4) => {
          if (t4 === 'stsz') return patchAudioStsz(c4, fakeCount);
          if (t4 === 'stsc') return patchAudioStsc(c4, origStcoCount, fakeCount);
          if (t4 === 'stco' || t4 === 'co64') return patchAudioStco(c4, fakeOffset, stcoShift);
          return c4;
        });
      });
    });
  });
}

// ─── Video stco shifting ────────────────────────────────────────────────────
function shiftStco(stco, shift) {
  const t = boxType(stco), step = t === 'co64' ? 8 : 4;
  const h = headerSize(stco);
  const n = readU32(stco, h + 4);
  const payload = stco.slice(h);
  for (let i = 0; i < n; i++) {
    const off = 8 + i * step;
    const val = step === 8 ? readU64(stco, h + off) : readU32(stco, h + off);
    const newVal = val + shift;
    if (step === 8) writeU64(payload, off, newVal); else writeU32(payload, off, newVal);
  }
  return makeBox(t, payload, h === 16);
}

function shiftVideoStco(trak, shift) {
  return rebuildContainer(trak, (child, t) => {
    if (t !== 'mdia') return child;
    return rebuildContainer(child, (c2, t2) => {
      if (t2 !== 'minf') return c2;
      return rebuildContainer(c2, (c3, t3) => {
        if (t3 !== 'stbl') return c3;
        return rebuildContainer(c3, (c4, t4) => {
          if (t4 !== 'stco' && t4 !== 'co64') return c4;
          return shiftStco(c4, shift);
        });
      });
    });
  });
}

// ─── Main patch function ────────────────────────────────────────────────────
function patchVideo(inputBuffer) {
  const buf = Buffer.isBuffer(inputBuffer) ? inputBuffer : Buffer.from(inputBuffer);

  const top = findTopBoxes(buf);
  const moovBytes = buf.slice(top.moov.start, top.moov.end);
  const mdatBytes = buf.slice(top.mdat.start, top.mdat.end);

  const moovChildren = parseBoxes(moovBytes, top.moov.header, moovBytes.length);
  let audioTrakBox = null, videoTrakBox = null;
  for (const b of moovChildren) {
    if (b.type !== 'trak') continue;
    const trakSlice = moovBytes.slice(b.start, b.end);
    const ht = handlerType(trakSlice);
    if (ht === 'soun' && !audioTrakBox) audioTrakBox = { box: b, slice: trakSlice };
    else if (ht === 'vide' && !videoTrakBox) videoTrakBox = { box: b, slice: trakSlice };
  }
  if (!audioTrakBox) throw new Error('No audio track found.');
  if (!videoTrakBox) throw new Error('No video track found.');

  const audioStbl = findPath(audioTrakBox.slice, ['mdia', 'minf', 'stbl']);
  const audioStsz = findChild(audioStbl, 'stsz');
  const audioSampleCount = readU32(audioStsz, 16);
  const audioFakeCount = audioSampleCount * FAKE_PER_REAL;

  const audioTrakTest = makeAudioTrak(audioTrakBox.slice, audioFakeCount, 0, 0);
  const newAudioTrakSize = audioTrakTest.length;
  const oldAudioTrakSize = audioTrakBox.box.end - audioTrakBox.box.start;

  let preMoovSize = 0;
  for (const b of top.boxes) {
    if (b.type === 'moov') break;
    if (b.type !== 'mdat') preMoovSize += b.size;
  }
  let postMoovBeforeMdatSize = 0, passedMoov = false;
  for (const b of top.boxes) {
    if (b.type === 'moov') { passedMoov = true; continue; }
    if (b.type === 'mdat') break;
    if (passedMoov && b.type !== 'free') postMoovBeforeMdatSize += b.size;
  }

  const moovSizeDelta = newAudioTrakSize - oldAudioTrakSize;
  let freeBoxSize = 0;
  for (const b of top.boxes) { if (b.type === 'free') freeBoxSize += b.size; }
  const stcoShift = moovSizeDelta - freeBoxSize;
  const newMoovSize = top.moov.size + moovSizeDelta;
  const newMdatStart = preMoovSize + newMoovSize + postMoovBeforeMdatSize;
  const fakeOffset = newMdatStart + mdatBytes.length;

  const finalAudioTrak = makeAudioTrak(audioTrakBox.slice, audioFakeCount, fakeOffset, stcoShift);
  const shiftedVideoTrak = shiftVideoStco(videoTrakBox.slice, stcoShift);

  const finalMoovChildren = [];
  for (const b of moovChildren) {
    if (b.type === 'trak') {
      const trakSlice = moovBytes.slice(b.start, b.end);
      const ht = handlerType(trakSlice);
      if (ht === 'soun') finalMoovChildren.push(finalAudioTrak);
      else if (ht === 'vide') finalMoovChildren.push(shiftedVideoTrak);
      else finalMoovChildren.push(trakSlice);
    } else {
      finalMoovChildren.push(moovBytes.slice(b.start, b.end));
    }
  }
  const moovHeader = moovBytes.slice(0, top.moov.header);
  const finalMoov = concat([moovHeader, ...finalMoovChildren]);
  writeU32(finalMoov, 0, finalMoov.length);

  const parts = [];
  for (const b of top.boxes) {
    if (b.type === 'moov') parts.push(finalMoov);
    else if (b.type === 'mdat') parts.push(mdatBytes);
    else if (b.type === 'free') { /* drop free box like Kuronai */ }
    else parts.push(buf.slice(b.start, b.end));
  }

  const fakeSamples = Buffer.alloc(audioFakeCount * FAKE_SAMPLE.length);
  for (let i = 0; i < audioFakeCount; i++) FAKE_SAMPLE.copy(fakeSamples, i * FAKE_SAMPLE.length);
  parts.push(fakeSamples);

  return concat(parts);
}

function findTopBoxes(buf) {
  const boxes = parseBoxes(buf, 0, buf.length);
  const moov = boxes.find(b => b.type === 'moov');
  const mdat = boxes.find(b => b.type === 'mdat');
  if (!moov) throw new Error('No moov atom found.');
  if (!mdat) throw new Error('No mdat atom found.');
  return { boxes, moov, mdat };
}

module.exports = { patchVideo };
