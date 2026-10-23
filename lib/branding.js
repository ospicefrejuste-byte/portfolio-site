"use strict";

const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { fail } = require("./security");

const MAX_LOGO_BYTES = 40 * 1024;
const MAX_LOGO_SIDE = 512;
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 255] ^ value >>> 8;
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii"), result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0); name.copy(result, 4); data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8);
  return result;
}

function canonicalLogo(dataUrl) {
  const invalid = () => fail(400, "Choisissez une image PNG valide préparée par le formulaire de logo.");
  if (typeof dataUrl !== "string" || dataUrl.length > 22 + Math.ceil(MAX_LOGO_BYTES / 3) * 4 || !/^data:image\/png;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(dataUrl)) throw invalid();
  const encoded = dataUrl.slice(22), source = Buffer.from(encoded, "base64");
  if (source.toString("base64") !== encoded || source.length > MAX_LOGO_BYTES || source.length < 57 || !source.subarray(0, 8).equals(SIGNATURE)) throw invalid();
  let offset = 8, header = null, width = 0, height = 0, channels = 0, ended = false, imageEnded = false;
  const image = [];
  while (offset < source.length) {
    if (ended || source.length - offset < 12) throw invalid();
    const length = source.readUInt32BE(offset);
    if (length > source.length - offset - 12) throw invalid();
    const name = source.subarray(offset + 4, offset + 8), type = name.toString("ascii"), data = source.subarray(offset + 8, offset + 8 + length);
    if (name.some(byte => !(byte >= 65 && byte <= 90 || byte >= 97 && byte <= 122)) || name[2] & 32 || crc32(source.subarray(offset + 4, offset + 8 + length)) !== source.readUInt32BE(offset + 8 + length)) throw invalid();
    offset += length + 12;
    if (!header && type !== "IHDR") throw invalid();
    if (type === "IHDR") {
      if (header || length !== 13) throw invalid();
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0;
      if (width < 1 || height < 1 || width > MAX_LOGO_SIDE || height > MAX_LOGO_SIDE || data[8] !== 8 || !channels || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) throw invalid();
      header = Buffer.from(data);
    } else if (type === "IDAT") {
      if (imageEnded) throw invalid();
      image.push(data);
    } else if (type === "IEND") {
      if (length || !image.length) throw invalid();
      ended = true;
    } else {
      // Ancillary metadata is removed, never decompressed or served. Reject
      // animations, alternate pixel representations and unknown critical data.
      if (["acTL", "fcTL", "fdAT", "tRNS"].includes(type) || !(name[0] & 32)) throw invalid();
      if (image.length) imageEnded = true;
    }
  }
  if (!ended || !header || offset !== source.length) throw invalid();
  const stride = width * channels + 1, expected = stride * height;
  let raster;
  try { raster = zlib.inflateSync(Buffer.concat(image), { maxOutputLength: expected }); } catch { throw invalid(); }
  if (raster.length !== expected) throw invalid();
  for (let row = 0; row < height; row++) if (raster[row * stride] > 4) throw invalid();
  const bytes = Buffer.concat([SIGNATURE, pngChunk("IHDR", header), pngChunk("IDAT", zlib.deflateSync(raster, { level: 9 })), pngChunk("IEND", Buffer.alloc(0))]);
  if (bytes.length > MAX_LOGO_BYTES) throw fail(400, "L’image du logo doit peser au maximum 40 Ko après préparation. Choisissez une image plus simple.");
  return { data: bytes.toString("base64"), digest: crypto.createHash("sha256").update(bytes).digest("hex"), width, height };
}

module.exports = { canonicalLogo, MAX_LOGO_BYTES, MAX_LOGO_SIDE };
