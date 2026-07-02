import { NetCDFReader } from "netcdfjs";
import * as hdf5 from "jsfive";
import type { FeatureCollection } from "./types/geolibre";

type NetCDFVariable = NetCDFReader["variables"][number];

export interface NetCDFSummary {
  format: "netcdf3" | "netcdf4";
  dimensions: NetCDFReader["dimensions"];
  variables: VariableSummary[];
  latVariable?: VariableSummary;
  lonVariable?: VariableSummary;
  dataVariables: VariableSummary[];
  readVariable: (name: string) => Array<string | number | number[]>;
}

export interface VariableSummary {
  name: string;
  type: string;
  dimensions: { id: number; name: string; size: number }[];
  attributes: Record<string, string | number>;
}

export interface SliceSelection {
  variableName: string;
  fixedDimensions: Record<string, number>;
  maxFeatures: number;
}

export interface RasterGridSelection {
  variableName: string;
  fixedDimensions: Record<string, number>;
  maxPixels: number;
}

export interface GeoJsonConversionResult {
  collection: FeatureCollection;
  bounds: [number, number, number, number];
  sampledEvery: number;
  validValueCount: number;
}

export interface RasterGridResult {
  variableName: string;
  width: number;
  height: number;
  values: Float32Array;
  lonCenters: number[];
  latCenters: number[];
  bounds: [number, number, number, number];
  valueRange: [number, number];
  validValueCount: number;
  sampledEvery: number;
}

const LAT_NAMES = new Set(["lat", "latitude", "y", "nav_lat"]);
const LON_NAMES = new Set(["lon", "lng", "long", "longitude", "x", "nav_lon"]);
const MISSING_ATTRIBUTE_NAMES = [
  "_FillValue",
  "missing_value",
  "MissingValue",
  "missingValue"
];

export function summarizeNetCDF(data: ArrayBuffer): NetCDFSummary {
  if (isHdf5(data)) {
    return summarizeNetCDF4(data);
  }

  const reader = new NetCDFReader(data);
  const dimensions = reader.dimensions;
  const variables = reader.variables.map((variable) =>
    summarizeVariable(variable, dimensions)
  );
  const latVariable = variables.find(isLatitudeVariable);
  const lonVariable = variables.find(isLongitudeVariable);
  const dataVariables = variables.filter((variable) =>
    isRenderableDataVariable(variable, latVariable, lonVariable)
  );

  return {
    format: "netcdf3",
    dimensions,
    variables,
    latVariable,
    lonVariable,
    dataVariables,
    readVariable: (name) => reader.getDataVariable(name)
  };
}

export function variableLabel(variable: VariableSummary): string {
  const dims = variable.dimensions.map((dimension) => dimension.name).join(", ");
  return `${variable.name}${dims ? ` (${dims})` : ""}`;
}

export function getDefaultFixedDimensions(variable: VariableSummary): Record<string, number> {
  const fixed: Record<string, number> = {};
  for (const dimension of variable.dimensions) {
    if (!isLatLike(dimension.name) && !isLonLike(dimension.name)) {
      fixed[dimension.name] = 0;
    }
  }
  return fixed;
}

export function toPointFeatureCollection(
  summary: NetCDFSummary,
  selection: SliceSelection
): GeoJsonConversionResult {
  const variable = summary.variables.find(
    (candidate) => candidate.name === selection.variableName
  );
  if (!variable) {
    throw new Error(`Variable not found: ${selection.variableName}`);
  }
  if (!summary.latVariable || !summary.lonVariable) {
    throw new Error("Could not identify latitude and longitude coordinate variables.");
  }

  const latDimensionIndex = findDimensionPosition(variable, summary.latVariable);
  const lonDimensionIndex = findDimensionPosition(variable, summary.lonVariable);
  if (latDimensionIndex < 0 || lonDimensionIndex < 0) {
    throw new Error("Selected variable does not use the detected latitude/longitude dimensions.");
  }

  const latValues = numericArray(summary.readVariable(summary.latVariable.name));
  const lonValues = numericArray(summary.readVariable(summary.lonVariable.name));
  const values = numericArray(summary.readVariable(variable.name));
  const latCount = variable.dimensions[latDimensionIndex]?.size ?? 0;
  const lonCount = variable.dimensions[lonDimensionIndex]?.size ?? 0;
  const targetMax = Math.max(1, selection.maxFeatures || 20000);
  const sampledEvery = Math.max(1, Math.ceil(Math.sqrt((latCount * lonCount) / targetMax)));
  const missingValues = getMissingValues(variable);
  const features: FeatureCollection["features"] = [];
  let west = 180;
  let south = 90;
  let east = -180;
  let north = -90;
  let validValueCount = 0;

  for (let latIndex = 0; latIndex < latCount; latIndex += sampledEvery) {
    for (let lonIndex = 0; lonIndex < lonCount; lonIndex += sampledEvery) {
      const flatIndex = flatIndexFor(variable, {
        latDimensionIndex,
        lonDimensionIndex,
        latIndex,
        lonIndex,
        fixedDimensions: selection.fixedDimensions
      });
      const value = values[flatIndex];
      const lat = latValues[latIndex];
      const lon = normalizeLongitude(lonValues[lonIndex]);

      if (!Number.isFinite(lat) || !Number.isFinite(lon) || !isValidValue(value, missingValues)) {
        continue;
      }

      west = Math.min(west, lon);
      south = Math.min(south, lat);
      east = Math.max(east, lon);
      north = Math.max(north, lat);
      validValueCount += 1;
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [lon, lat] },
        properties: {
          value,
          variable: variable.name
        }
      });
    }
  }

  if (features.length === 0) {
    throw new Error("No valid grid cells were found for the selected slice.");
  }

  return {
    collection: { type: "FeatureCollection", features },
    bounds: [west, south, east, north],
    sampledEvery,
    validValueCount
  };
}

export function toRasterGrid(
  summary: NetCDFSummary,
  selection: RasterGridSelection
): RasterGridResult {
  const variable = summary.variables.find(
    (candidate) => candidate.name === selection.variableName
  );
  if (!variable) {
    throw new Error(`Variable not found: ${selection.variableName}`);
  }
  if (!summary.latVariable || !summary.lonVariable) {
    throw new Error("Could not identify latitude and longitude coordinate variables.");
  }

  const latDimensionIndex = findDimensionPosition(variable, summary.latVariable);
  const lonDimensionIndex = findDimensionPosition(variable, summary.lonVariable);
  if (latDimensionIndex < 0 || lonDimensionIndex < 0) {
    throw new Error("Selected variable does not use the detected latitude/longitude dimensions.");
  }

  const latValues = numericArray(summary.readVariable(summary.latVariable.name));
  const lonValues = numericArray(summary.readVariable(summary.lonVariable.name)).map(normalizeLongitude);
  const values = numericArray(summary.readVariable(variable.name));
  const latCount = variable.dimensions[latDimensionIndex]?.size ?? 0;
  const lonCount = variable.dimensions[lonDimensionIndex]?.size ?? 0;
  const maxPixels = Math.max(1, selection.maxPixels || 1000000);
  const sampledEvery = Math.max(1, Math.ceil(Math.sqrt((latCount * lonCount) / maxPixels)));
  const width = Math.ceil(lonCount / sampledEvery);
  const height = Math.ceil(latCount / sampledEvery);
  const rasterValues = new Float32Array(width * height);
  const lonCenters = new Array<number>(width);
  const latCenters = new Array<number>(height);
  rasterValues.fill(Number.NaN);
  const missingValues = getMissingValues(variable);
  const latAscending = (latValues[0] ?? 0) <= (latValues[latCount - 1] ?? 0);
  let minValue = Number.POSITIVE_INFINITY;
  let maxValue = Number.NEGATIVE_INFINITY;
  let validValueCount = 0;

  for (let row = 0; row < height; row += 1) {
    const sourceLatIndex = latAscending
      ? latCount - 1 - row * sampledEvery
      : row * sampledEvery;
    latCenters[row] = latValues[sourceLatIndex];
    for (let column = 0; column < width; column += 1) {
      const sourceLonIndex = column * sampledEvery;
      lonCenters[column] = lonValues[sourceLonIndex];
      const flatIndex = flatIndexFor(variable, {
        latDimensionIndex,
        lonDimensionIndex,
        latIndex: sourceLatIndex,
        lonIndex: sourceLonIndex,
        fixedDimensions: selection.fixedDimensions
      });
      const value = values[flatIndex];
      if (!isValidValue(value, missingValues)) {
        continue;
      }
      const outputIndex = row * width + column;
      rasterValues[outputIndex] = value;
      minValue = Math.min(minValue, value);
      maxValue = Math.max(maxValue, value);
      validValueCount += 1;
    }
  }

  if (validValueCount === 0) {
    throw new Error("No valid grid cells were found for the selected slice.");
  }

  return {
    variableName: variable.name,
    width,
    height,
    values: rasterValues,
    lonCenters,
    latCenters,
    bounds: getGridBounds(lonValues, latValues),
    valueRange: [minValue, maxValue],
    validValueCount,
    sampledEvery
  };
}

export function flatIndexFor(
  variable: VariableSummary,
  options: {
    latDimensionIndex: number;
    lonDimensionIndex: number;
    latIndex: number;
    lonIndex: number;
    fixedDimensions: Record<string, number>;
  }
): number {
  let index = 0;
  for (const [position, dimension] of variable.dimensions.entries()) {
    const selected =
      position === options.latDimensionIndex
        ? options.latIndex
        : position === options.lonDimensionIndex
          ? options.lonIndex
          : (options.fixedDimensions[dimension.name] ?? 0);
    index = index * dimension.size + clampIndex(selected, dimension.size);
  }
  return index;
}

function summarizeVariable(
  variable: NetCDFVariable,
  dimensions: NetCDFReader["dimensions"]
): VariableSummary {
  return {
    name: variable.name,
    type: variable.type,
    dimensions: variable.dimensions.map((id) => ({
      id,
      name: dimensions[id]?.name ?? `dimension-${id}`,
      size: dimensions[id]?.size ?? 0
    })),
    attributes: attributesToRecord((variable as unknown as { attributes?: unknown }).attributes)
  };
}

function summarizeNetCDF4(data: ArrayBuffer): NetCDFSummary {
  const file = new hdf5.File(data, "dataset.nc");
  const datasets = listRootDatasets(file);
  const dimensionIds = new Map<string, number>();
  const dimensions: NetCDFReader["dimensions"] = [];

  const getDimension = (name: string, size: number) => {
    const cleanName = cleanAttributeString(name);
    const existing = dimensionIds.get(cleanName);
    if (existing !== undefined) {
      return { id: existing, name: cleanName, size: dimensions[existing]?.size ?? size };
    }
    const id = dimensions.length;
    dimensionIds.set(cleanName, id);
    dimensions.push({ name: cleanName, size });
    return { id, name: cleanName, size };
  };

  const variables = datasets.map(({ name, dataset }) => {
    const attrs = attributesToRecord(dataset.attrs);
    const shape = getDatasetShape(dataset);
    const coordinateNames = getCoordinateNames(attrs);
    const dimensionNames =
      coordinateNames.length === shape.length
        ? coordinateNames
        : shape.length === 1
          ? [name]
          : shape.map((_size, index) => `dimension-${index}`);

    return {
      name,
      type: String(dataset.dtype ?? "unknown"),
      dimensions: shape.map((size, index) => getDimension(dimensionNames[index] ?? `dimension-${index}`, size)),
      attributes: attrs
    };
  });

  const latVariable = variables.find(isLatitudeVariable);
  const lonVariable = variables.find(isLongitudeVariable);
  const dataVariables = variables.filter((variable) =>
    isRenderableDataVariable(variable, latVariable, lonVariable)
  );

  return {
    format: "netcdf4",
    dimensions,
    variables,
    latVariable,
    lonVariable,
    dataVariables,
    readVariable: (name) => {
      const dataset = file.get(name) as Hdf5Dataset;
      return Array.from(dataset.value ?? []) as Array<string | number | number[]>;
    }
  };
}

function attributesToRecord(attributes: unknown): Record<string, string | number> {
  const record: Record<string, string | number> = {};
  if (Array.isArray(attributes)) {
    for (const attribute of attributes) {
      if (
        attribute &&
        typeof attribute === "object" &&
        "name" in attribute &&
        "value" in attribute
      ) {
        const name = String((attribute as { name: unknown }).name);
        const value = normalizeAttributeValue((attribute as { value: unknown }).value);
        if (typeof value === "string" || typeof value === "number") {
          record[name] = value;
        }
      }
    }
    return record;
  }

  if (attributes && typeof attributes === "object") {
    for (const [name, rawValue] of Object.entries(attributes)) {
      const value = normalizeAttributeValue(rawValue);
      if (typeof value === "string" || typeof value === "number") {
        record[name] = value;
      }
    }
  }

  return record;
}

function normalizeAttributeValue(value: unknown): string | number | undefined {
  if (Array.isArray(value) && value.length === 1) {
    return normalizeAttributeValue(value[0]);
  }
  if (typeof value === "string") {
    return cleanAttributeString(value);
  }
  if (typeof value === "number") {
    return value;
  }
  return undefined;
}

function listRootDatasets(file: Hdf5File): Array<{ name: string; dataset: Hdf5Dataset }> {
  const datasets: Array<{ name: string; dataset: Hdf5Dataset }> = [];
  for (const name of file.keys ?? []) {
    const dataset = file.get(name) as Hdf5Dataset;
    if (Array.isArray(dataset.shape)) {
      datasets.push({ name, dataset });
    }
  }
  return datasets;
}

function getDatasetShape(dataset: Hdf5Dataset): number[] {
  return Array.isArray(dataset.shape) ? dataset.shape.map(Number) : [];
}

function getCoordinateNames(attributes: Record<string, string | number>): string[] {
  const coordinates = attributes.coordinates;
  return typeof coordinates === "string"
    ? coordinates.split(/\s+/).filter(Boolean).map(cleanAttributeString)
    : [];
}

function cleanAttributeString(value: string): string {
  return value.replace(/\0/g, "").trim();
}

function isHdf5(data: ArrayBuffer): boolean {
  const signature = new Uint8Array(data, 0, Math.min(8, data.byteLength));
  return (
    signature.length >= 8 &&
    signature[0] === 0x89 &&
    signature[1] === 0x48 &&
    signature[2] === 0x44 &&
    signature[3] === 0x46 &&
    signature[4] === 0x0d &&
    signature[5] === 0x0a &&
    signature[6] === 0x1a &&
    signature[7] === 0x0a
  );
}

interface Hdf5File {
  keys?: string[];
  get: (path: string) => unknown;
}

interface Hdf5Dataset {
  shape?: number[];
  dtype?: string;
  attrs?: unknown;
  value?: ArrayLike<string | number | number[]>;
}

function isRenderableDataVariable(
  variable: VariableSummary,
  latVariable?: VariableSummary,
  lonVariable?: VariableSummary
): boolean {
  if (!latVariable || !lonVariable) {
    return false;
  }
  if (variable.name === latVariable.name || variable.name === lonVariable.name) {
    return false;
  }
  if (variable.type === "char" || variable.type === "byte") {
    return false;
  }
  return findDimensionPosition(variable, latVariable) >= 0 && findDimensionPosition(variable, lonVariable) >= 0;
}

function findDimensionPosition(
  variable: VariableSummary,
  coordinateVariable: VariableSummary
): number {
  const coordinateDimension = coordinateVariable.dimensions[0];
  if (!coordinateDimension) {
    return -1;
  }
  return variable.dimensions.findIndex((dimension) => dimension.id === coordinateDimension.id);
}

function isLatitudeVariable(variable: VariableSummary): boolean {
  const units = String(variable.attributes.units ?? "").toLowerCase();
  return isLatLike(variable.name) || units.includes("degrees_north");
}

function isLongitudeVariable(variable: VariableSummary): boolean {
  const units = String(variable.attributes.units ?? "").toLowerCase();
  return isLonLike(variable.name) || units.includes("degrees_east");
}

function isLatLike(name: string): boolean {
  return LAT_NAMES.has(name.toLowerCase());
}

function isLonLike(name: string): boolean {
  return LON_NAMES.has(name.toLowerCase());
}

function numericArray(values: ReturnType<NetCDFReader["getDataVariable"]>): number[] {
  return values.map((value) => (typeof value === "number" ? value : Number.NaN));
}

function getMissingValues(variable: VariableSummary): Set<number> {
  const missing = new Set<number>();
  for (const name of MISSING_ATTRIBUTE_NAMES) {
    const value = variable.attributes[name];
    if (typeof value === "number") {
      missing.add(value);
    }
  }
  return missing;
}

function isValidValue(value: number, missingValues: Set<number>): boolean {
  return Number.isFinite(value) && !missingValues.has(value);
}

function normalizeLongitude(value: number): number {
  if (!Number.isFinite(value)) {
    return value;
  }
  return value > 180 ? value - 360 : value;
}

function clampIndex(value: number, size: number): number {
  return Math.max(0, Math.min(size - 1, Math.trunc(value)));
}

function getGridBounds(lonValues: number[], latValues: number[]): [number, number, number, number] {
  const validLon = lonValues.filter(Number.isFinite);
  const validLat = latValues.filter(Number.isFinite);
  if (validLon.length === 0 || validLat.length === 0) {
    throw new Error("Latitude or longitude coordinate values are missing.");
  }

  const west = Math.min(...validLon);
  const east = Math.max(...validLon);
  const south = Math.min(...validLat);
  const north = Math.max(...validLat);
  return [
    west - coordinatePadding(validLon),
    south - coordinatePadding(validLat),
    east + coordinatePadding(validLon),
    north + coordinatePadding(validLat)
  ];
}

function coordinatePadding(values: number[]): number {
  if (values.length < 2) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  let smallestStep = Number.POSITIVE_INFINITY;
  for (let index = 1; index < sorted.length; index += 1) {
    const step = Math.abs(sorted[index] - sorted[index - 1]);
    if (step > 0) {
      smallestStep = Math.min(smallestStep, step);
    }
  }
  return Number.isFinite(smallestStep) ? smallestStep / 2 : 0;
}
