// MP4 audio-fake patch engine — Node.js port of the client-side RiZip 120FPS method.
// Patches audio track metadata with phantom samples to prevent TikTok compression/hiding.

const FAKE_SAMPLE = Buffer.from([0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00]);
const FAKE_PER_REAL = 9;

// ─── Byte helpers ───────────────────────────────────────────────────────────
function readU32(b, o) { return b.readUInt32BE(o); }
function readI32(b, o) { return b.readInt32BE(o); }
function readU64(b, o) { return b.readUInt32BE(o) * 4294967296 + b.readUInt32BE(o + 4); }
function writeU32(b, o, v) { b.writeUInt32BE(v >>> 0, o); }
function writeU64(b, o, v) { const hi = Math.floor(v / 4294967296); writeU32(b, o, hi); writeU32(b, o + 4, (v - hi * 4294967296) >>> 0); }

// ─── MP4 box helpers ────────────────────────────────────────────────────────
function typeAt(b, o) { return b.toString('ascii', o, o + 4); }
function boxHeader(b, o) { return readU32(b, o) === 1 ? 16 : 8; }
function boxSize(b, o) { return readU32(b, o) === 1 ? readU64(b, o + 8) : readU32(b, o); }

function parseBoxes(buf, start, end) {
  const out = [];
  let pos = start;
  while (pos + 8 <= end) {
    const sz = boxSize(buf, pos);
    if (sz < 8 || pos + sz > end) break;
    out.push({ type: typeAt(buf, pos + 4), start: pos, end: pos + sz, header: boxHeader(buf, pos) });
    pos += sz;
  }
  return out;
}

function findChild(buf, start, end, type) {
  for (const b of parseBoxes(buf, start, end)) {
    if (b.type === type) return b;
  }
  return null;
}

function findPath(buf, start, end, path) {
  let s = start, e = end;
  for (const t of path) {
    const child = findChild(buf, s, e, t);
    if (!child) return null;
    s = child.start + child.header;
    e = child.end;
  }
  return { start: s, end: e };
}

function childStart(buf, o) {
  const t = typeAt(buf, o + 4), h = boxHeader(buf, o);
  return t === 'meta' ? h + 4 : h;
}

function rebuildContainer(buf, boxStart, mapChild) {
  const h = boxHeader(buf, boxStart);
  const type = typeAt(buf, boxStart + 4);
  const cs = boxStart + h;
  const ce = boxStart + boxSize(buf, boxStart);
  const children = parseBoxes(buf, cs, ce);

  const parts = [];
  for (const ch of children) {
    const childBuf = buf.slice(ch.start, ch.end);
    const mapped = mapChild(childBuf, ch.type);
    if (mapped) parts.push(mapped);
  }

  const payloadLen = parts.reduce((n, p) => n + p.length, 0);
  const totalSize = h + payloadLen;
  const out = Buffer.alloc(totalSize);
  if (h === 16) { writeU64(out, 0, totalSize); } else { writeU32(out, 0, totalSize); }
  out.write(type, 4, 'ascii');
  let off = h;
  for (const p of parts) { p.copy(out, off); off += p.length; }
  return out;
}

function readU32At(buf, o) { return buf.readUInt32BE(o); }
function handlerType(buf, trakStart, trakEnd) {
  const h = boxHeader(buf, trakStart);
  const trakChildren = parseBoxes(buf, trakStart + h, trakEnd);
  const mdia = trakChildren.find(b => b.type === 'mdia');
  if (!mdia) return '';
  const mdiaChildren = parseBoxes(buf, mdia.start + mdia.header, mdia.end);
  const hdlr = mdiaChildren.find(b => b.type === 'hdlr');
  if (!hdlr) return '';
  return typeAt(buf, hdlr.start + hdlr.header + 8);
}

// ─── Audio trak patching ────────────────────────────────────────────────────
function patchAudioTrak(origTrakBuf, fakeCount, fakeOffset, stcoShift) {
  // Find original stco count
  const h = boxHeader(origTrakBuf, 0);
  const trakChildren = parseBoxes(origTrakBuf, h, origTrakBuf.length);
  const mdiaBox = trakChildren.find(b => b.type === 'mdia');
  let origStcoCount = 0;
  if (mdiaBox) {
    const mdiaChildren = parseBoxes(origTrakBuf, mdiaBox.start + mdiaBox.header, mdiaBox.end);
    const minfBox = mdiaChildren.find(b => b.type === 'minf');
    if (minfBox) {
      const minfChildren = parseBoxes(origTrakBuf, minfBox.start + minfBox.header, minfBox.end);
      const stblBox = minfChildren.find(b => b.type === 'stbl');
      if (stblBox) {
        const stblChildren = parseBoxes(origTrakBuf, stblBox.start + stblBox.header, stblBox.end);
        const stco = stblChildren.find(b => b.type === 'stco' || b.type === 'co64');
        if (stco) origStcoCount = readU32At(origTrakBuf, stco.start + stco.header + 4);
      }
    }
  }

  return rebuildContainer(origTrakBuf, 0, (child, t) => {
    if (t === 'edts') return null;
    if (t !== 'mdia') return child;
    return rebuildContainer(child, 0, (c2, t2) => {
      if (t2 !== 'minf') return c2;
      return rebuildContainer(c2, 0, (c3, t3) => {
        if (t3 !== 'stbl') return c3;
        return rebuildContainer(c3, 0, (c4, t4) => {
          if (t4 === 'stsz') return patchAudioStsz(c4, fakeCount);
          if (t4 === 'stsc') return patchAudioStsc(c4, origStcoCount, fakeCount);
          if (t4 === 'stco' || t4 === 'co64') return patchAudioStco(c4, fakeOffset, stcoShift);
          return c4;
        });
      });
    });
  });
}

function patchAudioStsz(stszBuf, fakeCount) {
  const h = boxHeader(stszBuf);
  const oldCount = readU32At(stszBuf, h + 8);
  const oldPayload = stszBuf.slice(h);
  const payload = Buffer.alloc(oldPayload.length + fakeCount * 4);
  oldPayload.copy(payload);
  writeU32(payload, 8, oldCount + fakeCount);
  let o = oldPayload.length;
  for (let i = 0; i < fakeCount; i++, o += 4) writeU32(payload, o, FAKE_SAMPLE.length);

  const totalSize = h + payload.length;
  const out = Buffer.alloc(totalSize);
  if (h === 16) writeU64(out, 0, totalSize); else writeU32(out, 0, totalSize);
  out.write('stsz', 4, 'ascii');
  payload.copy(out, h);
  return out;
}

function patchAudioStsc(stscBuf, origStcoCount, fakeCount) {
  const h = boxHeader(stscBuf);
  const oldN = readU32At(stscBuf, h + 4);
  const oldPayload = stscBuf.slice(h);
  const payload = Buffer.alloc(oldPayload.length + 12);
  oldPayload.copy(payload);
  writeU32(payload, 4, oldN + 1);
  const o = oldPayload.length;
  writeU32(payload, o, origStcoCount + 1);
  writeU32(payload, o + 4, fakeCount);
  writeU32(payload, o + 8, 1);

  const totalSize = h + payload.length;
  const out = Buffer.alloc(totalSize);
  if (h === 16) writeU64(out, 0, totalSize); else writeU32(out, 0, totalSize);
  out.write('stsc', 4, 'ascii');
  payload.copy(out, h);
  return out;
}

function patchAudioStco(stcoBuf, fakeOffset, shift) {
  const t = typeAt(stcoBuf, 4);
  const step = t === 'co64' ? 8 : 4;
  const h = boxHeader(stcoBuf);
  const n = readU32At(stcoBuf, h + 4);
  const payload = Buffer.alloc(8 + (n + 1) * step);
  writeU32(payload, 4, n + 1);
  for (let i = 0; i < n; i++) {
    const off = h + 8 + i * step;
    const val = step === 8 ? readU64(stcoBuf, off) : readU32At(stcoBuf, off);
    const nv = val + shift;
    if (step === 8) writeU64(payload, 8 + i * step, nv); else writeU32(payload, 8 + i * step, nv);
  }
  const lastOff = 8 + n * step;
  if (step === 8) writeU64(payload, lastOff, fakeOffset); else writeU32(payload, lastOff, fakeOffset);

  const totalSize = h + payload.length;
  const out = Buffer.alloc(totalSize);
  if (h === 16) writeU64(out, 0, totalSize); else writeU32(out, 0, totalSize);
  out.write(t, 4, 'ascii');
  payload.copy(out, h);
  return out;
}

function shiftVideoStco(trakBuf, shift) {
  return rebuildContainer(trakBuf, 0, (child, t) => {
    if (t !== 'mdia') return child;
    return rebuildContainer(child, 0, (c2, t2) => {
      if (t2 !== 'minf') return c2;
      return rebuildContainer(c2, 0, (c3, t3) => {
        if (t3 !== 'stbl') return c3;
        return rebuildContainer(c3, 0, (c4, t4) => {
          if (t4 !== 'stco' && t4 !== 'co64') return c4;
          const ct = typeAt(c4, 4), step = ct === 'co64' ? 8 : 4;
          const ch = boxHeader(c4);
          const n = readU32At(c4, ch + 4);
          const payload = c4.slice(ch);
          for (let i = 0; i < n; i++) {
            const off = 8 + i * step;
            const val = step === 8 ? readU64(c4, ch + off) : readU32At(c4, ch + off);
            const nv = val + shift;
            if (step === 8) writeU64(payload, off, nv); else writeU32(payload, off, nv);
          }
          const totalSize = ch + payload.length;
          const out = Buffer.alloc(totalSize);
          if (ch === 16) writeU64(out, 0, totalSize); else writeU32(out, 0, totalSize);
          out.write(ct, 4, 'ascii');
          payload.copy(out, ch);
          return out;
        });
      });
    });
  });
}

// ─── Main patch function ────────────────────────────────────────────────────
function patchVideo(inputBuffer) {
  const buf = Buffer.isBuffer(inputBuffer) ? inputBuffer : Buffer.from(inputBuffer);

  // Parse top-level boxes
  const topBoxes = parseBoxes(buf, 0, buf.length);
  const moovBox = topBoxes.find(b => b.type === 'moov');
  const mdatBox = topBoxes.find(b => b.type === 'mdat');
  if (!moovBox) throw new Error('No moov atom found.');
  if (!mdatBox) throw new Error('No mdat atom found.');

  const moovBuf = buf.slice(moovBox.start, moovBox.end);
  const mdatBuf = buf.slice(mdatBox.start, mdatBox.end);

  // Find audio and video traks
  const moovChildren = parseBoxes(moovBuf, moovBox.header, moovBuf.length);
  let audioTrakBox = null, videoTrakBox = null;
  for (const b of moovChildren) {
    if (b.type !== 'trak') continue;
    const ht = handlerType(moovBuf, b.start, b.end);
    if (ht === 'soun' && !audioTrakBox) audioTrakBox = b;
    else if (ht === 'vide' && !videoTrakBox) videoTrakBox = b;
  }
  if (!audioTrakBox) throw new Error('No audio track found.');
  if (!videoTrakBox) throw new Error('No video track found.');

  // Get audio sample count
  const audioTrakBuf = moovBuf.slice(audioTrakBox.start, audioTrakBox.end);
  const audioTrakH = boxHeader(audioTrakBuf, 0);
  const audioTrakChildren = parseBoxes(audioTrakBuf, audioTrakH, audioTrakBuf.length);
  const mdiaBox = audioTrakChildren.find(b => b.type === 'mdia');
  if (!mdiaBox) throw new Error('No audio mdia found.');
  const mdiaChildren = parseBoxes(audioTrakBuf, mdiaBox.start + mdiaBox.header, mdiaBox.end);
  const minfBox = mdiaChildren.find(b => b.type === 'minf');
  if (!minfBox) throw new Error('No audio minf found.');
  const minfChildren = parseBoxes(audioTrakBuf, minfBox.start + minfBox.header, minfBox.end);
  const audioStbl = minfChildren.find(b => b.type === 'stbl');
  if (!audioStbl) throw new Error('No audio stbl found.');
  const stblChildren = parseBoxes(audioTrakBuf, audioStbl.start + audioStbl.header, audioStbl.end);
  const audioStsz = stblChildren.find(b => b.type === 'stsz');
  if (!audioStsz) throw new Error('No audio stsz found.');
  const audioSampleCount = readU32At(audioTrakBuf, audioStsz.start + audioStsz.header + 8);
  const audioFakeCount = audioSampleCount * FAKE_PER_REAL;

  // Calculate sizes
  const testAudioTrak = patchAudioTrak(audioTrakBuf, audioFakeCount, 0, 0);
  const newAudioTrakSize = testAudioTrak.length;
  const oldAudioTrakSize = audioTrakBox.end - audioTrakBox.start;

  let preMoovSize = 0;
  for (const b of topBoxes) { if (b.type === 'moov') break; if (b.type !== 'mdat') preMoovSize += b.size; }
  let postMoovBeforeMdatSize = 0, passedMoov = false;
  for (const b of topBoxes) {
    if (b.type === 'moov') { passedMoov = true; continue; }
    if (b.type === 'mdat') break;
    if (passedMoov && b.type !== 'free') postMoovBeforeMdatSize += b.size;
  }

  const moovSizeDelta = newAudioTrakSize - oldAudioTrakSize;
  let freeBoxSize = 0;
  for (const b of topBoxes) { if (b.type === 'free') freeBoxSize += b.size; }
  const stcoShift = moovSizeDelta - freeBoxSize;
  const newMoovSize = moovBox.size + moovSizeDelta;
  const newMdatStart = preMoovSize + newMoovSize + postMoovBeforeMdatSize;
  const fakeOffset = newMdatStart + mdatBuf.length;

  // Build final audio trak
  const finalAudioTrak = patchAudioTrak(audioTrakBuf, audioFakeCount, fakeOffset, stcoShift);

  // Build shifted video trak
  const videoTrakBuf = moovBuf.slice(videoTrakBox.start, videoTrakBox.end);
  const shiftedVideoTrak = shiftVideoStco(videoTrakBuf, stcoShift);

  // Assemble final moov
  const moovHeader = moovBuf.slice(0, moovBox.header);
  const moovParts = [moovHeader];
  for (const b of moovChildren) {
    if (b.type === 'trak') {
      const ht = handlerType(moovBuf, b.start, b.end);
      if (ht === 'soun') moovParts.push(finalAudioTrak);
      else if (ht === 'vide') moovParts.push(shiftedVideoTrak);
      else moovParts.push(moovBuf.slice(b.start, b.end));
    } else {
      moovParts.push(moovBuf.slice(b.start, b.end));
    }
  }
  const finalMoov = Buffer.concat(moovParts);
  writeU32(finalMoov, 0, finalMoov.length);

  // Assemble output: ftyp + moov + mdat + fakes (drop free box)
  const outputParts = [];
  for (const b of topBoxes) {
    if (b.type === 'moov') outputParts.push(finalMoov);
    else if (b.type === 'mdat') outputParts.push(mdatBuf);
    else if (b.type === 'free') { /* drop */ }
    else outputParts.push(buf.slice(b.start, b.end));
  }

  const fakeSamples = Buffer.alloc(audioFakeCount * FAKE_SAMPLE.length);
  for (let i = 0; i < audioFakeCount; i++) FAKE_SAMPLE.copy(fakeSamples, i * FAKE_SAMPLE.length);
  outputParts.push(fakeSamples);

  return Buffer.concat(outputParts);
}

module.exports = { patchVideo };
