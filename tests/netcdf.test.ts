import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fromArrayBuffer } from "geotiff";
import h5wasm from "h5wasm/node";
import {
  closeNetCDF,
  decodeValue,
  detectNetCDFSignature,
  flatIndexFor,
  getDefaultFixedDimensions,
  getTimeAxisInfo,
  summarizeNetCDF,
  toRasterGrid
} from "../src/netcdf";
import { rasterGridToGeoTiffBlob } from "../src/geotiff";
import type { RasterGridResult, VariableSummary } from "../src/netcdf";

const variable: VariableSummary = {
  name: "temperature",
  path: "/temperature",
  type: "<f",
  shape: [3, 4, 5],
  dimensions: [
    { id: 0, name: "time", size: 3 },
    { id: 1, name: "lat", size: 4 },
    { id: 2, name: "lon", size: 5 }
  ],
  attributes: {},
  isCoordinateVariable: false
};

describe("NetCDF grid helpers", () => {
  it("detects supported and unsupported file signatures", () => {
    expect(detectNetCDFSignature(new Uint8Array([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a]).buffer)).toBe("hdf5");
    expect(detectNetCDFSignature(new Uint8Array([0x43, 0x44, 0x46, 0x01]).buffer)).toBe("netcdf3");
    expect(detectNetCDFSignature(new Uint8Array([1, 2, 3, 4]).buffer)).toBe("unknown");
  });

  it("creates fixed dimensions for non-spatial axes", () => {
    expect(getDefaultFixedDimensions(variable)).toEqual({ time: 0 });
  });

  it("computes row-major flat indexes for sliced variables", () => {
    expect(
      flatIndexFor(variable, {
        latDimensionIndex: 1,
        lonDimensionIndex: 2,
        latIndex: 2,
        lonIndex: 3,
        fixedDimensions: { time: 1 }
      })
    ).toBe(33);
  });

  it("decodes scale, offset, fill, and valid range metadata", () => {
    const attrs = { _FillValue: -9999, scale_factor: 0.1, add_offset: 2, valid_range: [0, 100] };
    expect(decodeValue(30, attrs)).toBe(5);
    expect(decodeValue(-9999, attrs)).toBeNull();
    expect(decodeValue(2000, attrs)).toBeNull();
  });
});

describe("h5wasm NetCDF4/HDF5 files", () => {
  it("discovers coordinate variables and extracts a selected 2D slice", async () => {
    const fileBuffer = await createFixtureFile();
    const summary = await summarizeNetCDF(fileBuffer);

    try {
      expect(summary.format).toBe("netcdf4");
      expect(summary.latVariable?.name).toBe("lat");
      expect(summary.lonVariable?.name).toBe("lon");
      expect(summary.dataVariables.map((candidate) => candidate.name)).toContain("tavg");
      const timeAxis = getTimeAxisInfo(summary, summary.dataVariables[0].dimensions[0]);
      expect(timeAxis?.dates?.map((date) => date.toISOString().slice(0, 10))).toEqual([
        "2000-01-01",
        "2000-01-02"
      ]);

      const raster = await toRasterGrid(summary, {
        variableName: "tavg",
        fixedDimensions: { time: 1 },
        maxPixels: 1000000
      });
      expect(raster.width).toBe(3);
      expect(raster.height).toBe(2);
      expect(raster.validValueCount).toBe(6);
      expect(raster.valueRange).toEqual([16, 21]);
      expect(raster.bounds).toEqual([-5.5, 33.5, -2.5, 35.5]);
    } finally {
      closeNetCDF(summary);
    }
  });

  it("treats unsigned integer NetCDF raster variables as renderable", async () => {
    const fileBuffer = await createUnsignedIntegerFixtureFile();
    const summary = await summarizeNetCDF(fileBuffer);

    try {
      expect(summary.dataVariables.map((candidate) => candidate.name)).toContain("potential_evapotranspiration");

      const raster = await toRasterGrid(summary, {
        variableName: "potential_evapotranspiration",
        fixedDimensions: { day: 0 },
        maxPixels: 1000000
      });
      expect(raster.width).toBe(3);
      expect(raster.height).toBe(2);
      expect(raster.valueRange).toEqual([1, 6]);
    } finally {
      closeNetCDF(summary);
    }
  });
});

describe("GeoTIFF output", () => {
  it("writes a georeferenced GeoTIFF raster", async () => {
    const raster: RasterGridResult = {
      variableName: "temperature",
      width: 3,
      height: 2,
      values: new Float32Array([1, 2, 3, 4, Number.NaN, 6]),
      lonCenters: [-5, -4, -3],
      latCenters: [36, 35],
      bounds: [-5.5, 34.5, -2.5, 36.5],
      valueRange: [1, 6],
      validValueCount: 5,
      sampledEvery: 1
    };
    const blob = rasterGridToGeoTiffBlob(raster);
    const tiff = await fromArrayBuffer(await blob.arrayBuffer());
    const image = await tiff.getImage();

    expect(image.getWidth()).toBe(raster.width);
    expect(image.getHeight()).toBe(raster.height);
    expect(image.getBoundingBox()).toEqual(raster.bounds);
    const geoKeys = image.getGeoKeys();
    expect(geoKeys?.GeographicTypeGeoKey).toBe(4326);
  });
});

async function createFixtureFile(): Promise<ArrayBuffer> {
  await h5wasm.ready;
  const dir = mkdtempSync(join(tmpdir(), "geolibre-netcdf-"));
  const filePath = join(dir, "fixture.nc");
  try {
    const file = new h5wasm.File(filePath, "w");
    const time = file.create_dataset({ name: "time", data: new Float64Array([0, 1]), shape: [2] });
    const lat = file.create_dataset({ name: "lat", data: new Float64Array([34, 35]), shape: [2] });
    const lon = file.create_dataset({ name: "lon", data: new Float64Array([-5, -4, -3]), shape: [3] });
    time.make_scale("time");
    time.create_attribute("units", "days since 2000-01-01 00:00:00");
    time.create_attribute("standard_name", "time");
    time.create_attribute("calendar", "gregorian");
    lat.make_scale("lat");
    lon.make_scale("lon");
    lat.create_attribute("units", "degrees_north");
    lon.create_attribute("units", "degrees_east");
    const data = file.create_dataset({
      name: "tavg",
      data: new Float32Array([
        10, 11, 12,
        13, 14, 15,
        16, 17, 18,
        19, 20, 21
      ]),
      shape: [2, 2, 3]
    });
    data.attach_scale(0, "time");
    data.attach_scale(1, "lat");
    data.attach_scale(2, "lon");
    data.create_attribute("long_name", "Mean air temperature");
    data.create_attribute("units", "degree_Celsius");
    file.flush();
    file.close();

    const buffer = readFileSync(filePath);
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function createUnsignedIntegerFixtureFile(): Promise<ArrayBuffer> {
  await h5wasm.ready;
  const dir = mkdtempSync(join(tmpdir(), "geolibre-netcdf-uint-"));
  const filePath = join(dir, "fixture-uint.nc");
  try {
    const file = new h5wasm.File(filePath, "w");
    const day = file.create_dataset({ name: "day", data: new Float64Array([0]), shape: [1] });
    const lat = file.create_dataset({ name: "lat", data: new Float64Array([34, 35]), shape: [2] });
    const lon = file.create_dataset({ name: "lon", data: new Float64Array([-5, -4, -3]), shape: [3] });
    day.make_scale("day");
    lat.make_scale("lat");
    lon.make_scale("lon");
    lat.create_attribute("units", "degrees_north");
    lon.create_attribute("units", "degrees_east");
    const data = file.create_dataset({
      name: "potential_evapotranspiration",
      data: new Uint16Array([1, 2, 3, 4, 5, 6]),
      shape: [1, 2, 3]
    });
    data.attach_scale(0, "day");
    data.attach_scale(1, "lat");
    data.attach_scale(2, "lon");
    data.create_attribute("long_name", "pet");
    data.create_attribute("units", "mm");
    data.create_attribute("_FillValue", new Uint16Array([32767]));
    data.create_attribute("missing_value", new Uint16Array([32767]));
    data.create_attribute("scale_factor", 1);
    data.create_attribute("add_offset", 0);
    file.flush();
    file.close();

    const buffer = readFileSync(filePath);
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
