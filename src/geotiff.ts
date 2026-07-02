import type { RasterGridResult } from "./netcdf";

const TIFF_TYPE_SHORT = 3;
const TIFF_TYPE_LONG = 4;
const TIFF_TYPE_ASCII = 2;
const TIFF_TYPE_DOUBLE = 12;

interface TiffEntry {
  tag: number;
  type: number;
  count: number;
  inlineValue?: number;
  data?: Uint8Array;
}

export function rasterGridToGeoTiffBlob(raster: RasterGridResult): Blob {
  const [west, south, east, north] = raster.bounds;
  const pixelWidth = (east - west) / raster.width;
  const pixelHeight = (north - south) / raster.height;
  const pixelBytes = raster.values.byteLength;

  const entries: TiffEntry[] = [
    shortEntry(256, raster.width),
    shortEntry(257, raster.height),
    shortEntry(258, 32),
    shortEntry(259, 1),
    shortEntry(262, 1),
    shortEntry(277, 1),
    shortEntry(284, 1),
    shortEntry(339, 3),
    longEntry(273, 0),
    longEntry(278, raster.height),
    longEntry(279, pixelBytes),
    dataEntry(33550, TIFF_TYPE_DOUBLE, doubles([pixelWidth, pixelHeight, 0])),
    dataEntry(33922, TIFF_TYPE_DOUBLE, doubles([0, 0, 0, west, north, 0])),
    dataEntry(34735, TIFF_TYPE_SHORT, shorts([
      1, 1, 0, 4,
      1024, 0, 1, 2,
      1025, 0, 1, 1,
      2048, 0, 1, 4326,
      2054, 0, 1, 9102
    ])),
    dataEntry(42113, TIFF_TYPE_ASCII, ascii("NaN"))
  ].sort((a, b) => a.tag - b.tag);

  const ifdOffset = 8;
  const ifdByteLength = 2 + entries.length * 12 + 4;
  let extraOffset = ifdOffset + ifdByteLength;
  for (const entry of entries) {
    if (entry.data && entry.data.byteLength > 4) {
      extraOffset += entry.data.byteLength + padding(entry.data.byteLength);
    }
  }
  const pixelOffset = extraOffset;
  const totalLength = pixelOffset + pixelBytes;
  const buffer = new ArrayBuffer(totalLength);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  view.setUint8(0, 0x49);
  view.setUint8(1, 0x49);
  view.setUint16(2, 42, true);
  view.setUint32(4, ifdOffset, true);
  view.setUint16(ifdOffset, entries.length, true);

  let entryOffset = ifdOffset + 2;
  let dataOffset = ifdOffset + ifdByteLength;
  for (const entry of entries) {
    view.setUint16(entryOffset, entry.tag, true);
    view.setUint16(entryOffset + 2, entry.type, true);
    view.setUint32(entryOffset + 4, entry.count, true);

    const valueOffset = entryOffset + 8;
    if (entry.tag === 273) {
      view.setUint32(valueOffset, pixelOffset, true);
    } else if (entry.data && entry.data.byteLength > 4) {
      view.setUint32(valueOffset, dataOffset, true);
      bytes.set(entry.data, dataOffset);
      dataOffset += entry.data.byteLength + padding(entry.data.byteLength);
    } else if (entry.data) {
      bytes.set(entry.data, valueOffset);
    } else {
      writeInlineValue(view, valueOffset, entry);
    }
    entryOffset += 12;
  }
  view.setUint32(ifdOffset + 2 + entries.length * 12, 0, true);

  const pixelView = new DataView(buffer, pixelOffset, pixelBytes);
  for (let index = 0; index < raster.values.length; index += 1) {
    pixelView.setFloat32(index * 4, raster.values[index], true);
  }

  return new Blob([buffer], { type: "image/tiff" });
}

function writeInlineValue(view: DataView, offset: number, entry: TiffEntry): void {
  const value = entry.inlineValue ?? 0;
  if (entry.type === TIFF_TYPE_SHORT) {
    view.setUint16(offset, value, true);
  } else {
    view.setUint32(offset, value, true);
  }
}

function shortEntry(tag: number, value: number): TiffEntry {
  return { tag, type: TIFF_TYPE_SHORT, count: 1, inlineValue: value };
}

function longEntry(tag: number, value: number): TiffEntry {
  return { tag, type: TIFF_TYPE_LONG, count: 1, inlineValue: value };
}

function dataEntry(tag: number, type: number, data: Uint8Array): TiffEntry {
  return { tag, type, count: dataCount(type, data), data };
}

function dataCount(type: number, data: Uint8Array): number {
  if (type === TIFF_TYPE_SHORT) {
    return data.byteLength / 2;
  }
  if (type === TIFF_TYPE_DOUBLE) {
    return data.byteLength / 8;
  }
  return data.byteLength;
}

function doubles(values: number[]): Uint8Array {
  const buffer = new ArrayBuffer(values.length * 8);
  const view = new DataView(buffer);
  values.forEach((value, index) => view.setFloat64(index * 8, value, true));
  return new Uint8Array(buffer);
}

function shorts(values: number[]): Uint8Array {
  const buffer = new ArrayBuffer(values.length * 2);
  const view = new DataView(buffer);
  values.forEach((value, index) => view.setUint16(index * 2, value, true));
  return new Uint8Array(buffer);
}

function ascii(value: string): Uint8Array {
  return new TextEncoder().encode(`${value}\0`);
}

function padding(byteLength: number): number {
  return byteLength % 2 === 0 ? 0 : 1;
}
