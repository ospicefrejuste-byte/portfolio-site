"use strict";
const zlib = require("node:zlib");

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type), bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length, 0); name.copy(bytes, 4); data.copy(bytes, 8);
  bytes.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8);
  return bytes;
}
function png({ width = 8, height = 8, colorType = 6, bitDepth = 8, interlace = 0, metadata = "", pixel = [30, 140, 55, 255], raw, suffix = Buffer.alloc(0), chunks } = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = bitDepth; header[9] = colorType; header[12] = interlace;
  if (!raw) {
    const channels = colorType === 2 ? 3 : 4;
    raw = Buffer.alloc((width * channels + 1) * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let channel = 0; channel < channels; channel++) raw[y * (width * channels + 1) + 1 + x * channels + channel] = pixel[channel];
  }
  const parts = chunks || [chunk("IHDR", header), ...(metadata ? [chunk("tEXt", Buffer.from(metadata))] : []), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))];
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...parts, suffix]);
}
const dataUrl = bytes => "data:image/png;base64," + bytes.toString("base64");
module.exports = { png, chunk, dataUrl };
