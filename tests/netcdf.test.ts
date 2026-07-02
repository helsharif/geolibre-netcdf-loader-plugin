import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fromArrayBuffer } from "geotiff";
import {
  flatIndexFor,
  getDefaultFixedDimensions,
  summarizeNetCDF,
  toPointFeatureCollection,
  toRasterGrid
} from "../src/netcdf";
import { rasterGridToGeoTiffBlob } from "../src/geotiff";
import type { VariableSummary } from "../src/netcdf";

const variable: VariableSummary = {
  name: "temperature",
  type: "float",
  dimensions: [
    { id: 0, name: "time", size: 3 },
    { id: 1, name: "lat", size: 4 },
    { id: 2, name: "lon", size: 5 }
  ],
  attributes: {}
};

describe("NetCDF grid helpers", () => {
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
});

describe("NetCDF4/HDF5 files", () => {
  const samplePath = resolve("example_netcdf_files/JVBC_HistAnalog_tavg.nc");

  it.skipIf(!existsSync(samplePath))("loads the JVBC historical analog sample", () => {
    const buffer = readFileSync(samplePath);
    const arrayBuffer = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength
    );
    const summary = summarizeNetCDF(arrayBuffer);

    expect(summary.format).toBe("netcdf4");
    expect(summary.latVariable?.name).toBe("lat");
    expect(summary.lonVariable?.name).toBe("lon");
    expect(summary.dataVariables.map((variable) => variable.name)).toContain("tavg");

    const result = toPointFeatureCollection(summary, {
      variableName: "tavg",
      fixedDimensions: { time: 0 },
      maxFeatures: 100
    });
    expect(result.collection.features.length).toBeGreaterThan(0);
    expect(result.bounds[0]).toBeLessThan(result.bounds[2]);
    expect(result.bounds[1]).toBeLessThan(result.bounds[3]);

    const raster = toRasterGrid(summary, {
      variableName: "tavg",
      fixedDimensions: { time: 0 },
      maxPixels: 1000000
    });
    expect(raster.width).toBe(30);
    expect(raster.height).toBe(20);
    expect(raster.validValueCount).toBeGreaterThan(0);
    expect(raster.validValueCount).toBeLessThanOrEqual(600);
    expect(raster.valueRange[0]).toBeLessThan(raster.valueRange[1]);
    expect(raster.bounds[0]).toBeLessThan(raster.bounds[2]);
    expect(raster.bounds[1]).toBeLessThan(raster.bounds[3]);
  }, 15000);

  it.skipIf(!existsSync(samplePath))("writes a georeferenced GeoTIFF raster", async () => {
    const buffer = readFileSync(samplePath);
    const arrayBuffer = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength
    );
    const summary = summarizeNetCDF(arrayBuffer);
    const raster = toRasterGrid(summary, {
      variableName: "tavg",
      fixedDimensions: { time: 0 },
      maxPixels: 1000000
    });
    const blob = rasterGridToGeoTiffBlob(raster);
    const tiff = await fromArrayBuffer(await blob.arrayBuffer());
    const image = await tiff.getImage();

    expect(image.getWidth()).toBe(raster.width);
    expect(image.getHeight()).toBe(raster.height);
    expect(image.getBoundingBox()).toEqual(raster.bounds);
    const geoKeys = image.getGeoKeys();
    expect(geoKeys?.GeographicTypeGeoKey).toBe(4326);
  }, 15000);
});
