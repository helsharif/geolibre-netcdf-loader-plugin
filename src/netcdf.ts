import h5wasm from "h5wasm";
import type { Dataset, Entity, Group, OutputData } from "h5wasm";
import type { FeatureCollection } from "./types/geolibre";

export interface NetCDFSummary {
  format: "netcdf4";
  handle: H5FileHandle;
  dimensions: DimensionSummary[];
  variables: VariableSummary[];
  latVariable?: VariableSummary;
  lonVariable?: VariableSummary;
  dataVariables: VariableSummary[];
}

export interface H5FileHandle {
  filename: string;
  file: InstanceType<typeof h5wasm.File>;
}

export interface DimensionSummary {
  id: number;
  name: string;
  size: number;
}

export interface VariableSummary {
  name: string;
  path: string;
  type: string;
  shape: number[];
  dimensions: DimensionSummary[];
  attributes: Record<string, string | number>;
  isCoordinateVariable: boolean;
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
const COORDINATE_NAMES = new Set([
  "lat",
  "latitude",
  "lon",
  "longitude",
  "time",
  "x",
  "y",
  "z",
  "lev",
  "level",
  "depth",
  "bnds",
  "bounds",
  "time_bnds",
  "lat_bnds",
  "lon_bnds",
  "crs",
  "spatial_ref"
]);
const MISSING_ATTRIBUTE_NAMES = [
  "_FillValue",
  "missing_value",
  "MissingValue",
  "missingValue"
];

export function detectNetCDFSignature(data: ArrayBuffer): "hdf5" | "netcdf3" | "unknown" {
  const bytes = new Uint8Array(data, 0, Math.min(8, data.byteLength));
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x48 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "hdf5";
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x43 &&
    bytes[1] === 0x44 &&
    bytes[2] === 0x46 &&
    [0x01, 0x02, 0x05].includes(bytes[3])
  ) {
    return "netcdf3";
  }
  return "unknown";
}

export async function summarizeNetCDF(data: ArrayBuffer): Promise<NetCDFSummary> {
  const signature = detectNetCDFSignature(data);
  if (signature === "netcdf3") {
    throw new Error("This file is classic NetCDF3/CDF. Version 1 currently supports NetCDF4/HDF5 files only.");
  }
  if (signature !== "hdf5") {
    throw new Error("This file is not recognized as NetCDF4/HDF5.");
  }

  const handle = await openH5File(data);
  const variables = discoverVariables(handle.file);
  const dimensions = collectDimensions(variables);
  const latVariable = variables.find(isLatitudeVariable);
  const lonVariable = variables.find(isLongitudeVariable);
  const dataVariables = variables.filter((variable) =>
    isRenderableDataVariable(variable, latVariable, lonVariable)
  );

  if (dataVariables.length === 0) {
    throw new Error("No supported CF-style rectilinear raster variables were found.");
  }

  return {
    format: "netcdf4",
    handle,
    dimensions,
    variables,
    latVariable,
    lonVariable,
    dataVariables
  };
}

export function closeNetCDF(summary: NetCDFSummary | undefined): void {
  try {
    summary?.handle.file.close();
  } catch {
    // Ignore close errors from already released HDF5 handles.
  }
}

export function variableLabel(variable: VariableSummary): string {
  const dims = variable.dimensions.map((dimension) => dimension.name).join(", ");
  const label = variable.attributes.long_name || variable.attributes.standard_name || variable.name;
  return `${label}${dims ? ` (${dims})` : ""}`;
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

export async function toPointFeatureCollection(
  summary: NetCDFSummary,
  selection: SliceSelection
): Promise<GeoJsonConversionResult> {
  const raster = await toRasterGrid(summary, {
    variableName: selection.variableName,
    fixedDimensions: selection.fixedDimensions,
    maxPixels: selection.maxFeatures
  });
  const targetMax = Math.max(1, selection.maxFeatures || 20000);
  const sampledEvery = Math.max(1, Math.ceil(Math.sqrt(raster.validValueCount / targetMax)));
  const features: FeatureCollection["features"] = [];
  let validValueCount = 0;

  for (let row = 0; row < raster.height; row += sampledEvery) {
    for (let column = 0; column < raster.width; column += sampledEvery) {
      const value = raster.values[row * raster.width + column];
      if (!Number.isFinite(value)) {
        continue;
      }
      validValueCount += 1;
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [raster.lonCenters[column], raster.latCenters[row]] },
        properties: { value, variable: raster.variableName }
      });
    }
  }

  if (features.length === 0) {
    throw new Error("No valid grid cells were found for the selected slice.");
  }

  return {
    collection: { type: "FeatureCollection", features },
    bounds: raster.bounds,
    sampledEvery: raster.sampledEvery * sampledEvery,
    validValueCount
  };
}

export async function toRasterGrid(
  summary: NetCDFSummary,
  selection: RasterGridSelection
): Promise<RasterGridResult> {
  const variable = findVariable(summary, selection.variableName);
  if (!summary.latVariable || !summary.lonVariable) {
    throw new Error("Could not identify latitude and longitude coordinate variables.");
  }

  const latDimensionIndex = findDimensionPosition(variable, summary.latVariable);
  const lonDimensionIndex = findDimensionPosition(variable, summary.lonVariable);
  if (latDimensionIndex < 0 || lonDimensionIndex < 0) {
    throw new Error("Selected variable does not use the detected latitude/longitude dimensions.");
  }

  const latValues = numericArray(readDataset(summary.handle.file, summary.latVariable.path).value);
  const lonValues = numericArray(readDataset(summary.handle.file, summary.lonVariable.path).value).map(
    normalizeLongitude
  );
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

  const sourceDataset = readDataset(summary.handle.file, variable.path);
  const sliceRanges = variable.dimensions.map((dimension, index) => {
    if (index === latDimensionIndex || index === lonDimensionIndex) {
      return [0, dimension.size, sampledEvery] as [number, number, number];
    }
    const selected = clampIndex(selection.fixedDimensions[dimension.name] ?? 0, dimension.size);
    return [selected, selected + 1, 1] as [number, number, number];
  });
  const sliceValues = numericArray(sourceDataset.slice(sliceRanges));
  const latAscending = (latValues[0] ?? 0) <= (latValues[latCount - 1] ?? 0);
  let minValue = Number.POSITIVE_INFINITY;
  let maxValue = Number.NEGATIVE_INFINITY;
  let validValueCount = 0;

  for (let row = 0; row < height; row += 1) {
    const sourceLatIndex = latAscending ? latCount - 1 - row * sampledEvery : row * sampledEvery;
    latCenters[row] = latValues[sourceLatIndex];
    for (let column = 0; column < width; column += 1) {
      const sourceLonIndex = column * sampledEvery;
      lonCenters[column] = lonValues[sourceLonIndex];
      const sourceRow = latAscending ? height - 1 - row : row;
      const rawValue = sliceValues[sourceRow * width + column];
      const value = decodeValue(rawValue, variable.attributes);
      if (value === null) {
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

export function decodeValue(raw: number, attrs: Record<string, unknown>): number | null {
  for (const name of MISSING_ATTRIBUTE_NAMES) {
    const missing = numericAttribute(attrs, name);
    if (missing !== undefined && raw === missing) {
      return null;
    }
  }

  const scaleFactor = numericAttribute(attrs, "scale_factor") ?? 1;
  const addOffset = numericAttribute(attrs, "add_offset") ?? 0;
  const value = raw * scaleFactor + addOffset;
  const validMin = numericAttribute(attrs, "valid_min");
  const validMax = numericAttribute(attrs, "valid_max");
  const validRange = arrayAttribute(attrs, "valid_range");

  if (validMin !== undefined && value < validMin) {
    return null;
  }
  if (validMax !== undefined && value > validMax) {
    return null;
  }
  if (validRange && (value < validRange[0] || value > validRange[1])) {
    return null;
  }
  return Number.isFinite(value) ? value : null;
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

async function openH5File(data: ArrayBuffer): Promise<H5FileHandle> {
  const module = await h5wasm.ready;
  const filename = `/geolibre-netcdf-${Date.now()}-${Math.random().toString(36).slice(2)}.nc`;
  module.FS.writeFile(filename, new Uint8Array(data));
  return { filename, file: new h5wasm.File(filename, "r") };
}

function discoverVariables(file: InstanceType<typeof h5wasm.File>): VariableSummary[] {
  const variables: VariableSummary[] = [];
  walkGroup(file, "", variables);
  return variables;
}

function walkGroup(group: Group, groupPath: string, variables: VariableSummary[]): void {
  for (const key of group.keys()) {
    const path = `${groupPath}/${key}`.replace(/\/+/g, "/");
    const entity = group.get(key);
    if (isDataset(entity)) {
      const shape = entity.shape ?? [];
      const dimensions = resolveDimensions(entity, key, shape);
      const attributes = attributesToRecord(entity);
      variables.push({
        name: key,
        path,
        type: String(entity.dtype),
        shape,
        dimensions,
        attributes,
        isCoordinateVariable: isCoordinateVariableName(key) || shape.length <= 1
      });
    } else if (isGroup(entity)) {
      walkGroup(entity, path, variables);
    }
  }
}

function resolveDimensions(dataset: Dataset, name: string, shape: number[]): DimensionSummary[] {
  const labels = dataset.get_dimension_labels();
  return shape.map((size, index) => {
    const scalePaths = dataset.get_attached_scales(index);
    const scaleName = scalePaths[0]?.split("/").filter(Boolean).pop();
    const label = labels[index] ?? scaleName ?? (shape.length === 1 ? name : `dimension-${index}`);
    return { id: index, name: label, size };
  });
}

function collectDimensions(variables: VariableSummary[]): DimensionSummary[] {
  const dimensions = new Map<string, DimensionSummary>();
  for (const variable of variables) {
    for (const dimension of variable.dimensions) {
      if (!dimensions.has(dimension.name)) {
        dimensions.set(dimension.name, { ...dimension, id: dimensions.size });
      }
    }
  }
  return [...dimensions.values()];
}

function attributesToRecord(entity: Dataset): Record<string, string | number> {
  const record: Record<string, string | number> = {};
  for (const [name, attribute] of Object.entries(entity.attrs)) {
    const value = normalizeAttributeValue(attribute.value);
    if (typeof value === "string" || typeof value === "number") {
      record[name] = value;
    }
  }
  return record;
}

function normalizeAttributeValue(value: unknown): string | number | undefined {
  if (ArrayBuffer.isView(value) && "length" in value && value.length === 1) {
    return normalizeAttributeValue((value as unknown as ArrayLike<unknown>)[0]);
  }
  if (Array.isArray(value) && value.length === 1) {
    return normalizeAttributeValue(value[0]);
  }
  if (typeof value === "string") {
    return value.replace(/\0/g, "").trim();
  }
  if (typeof value === "number") {
    return value;
  }
  return undefined;
}

function readDataset(file: InstanceType<typeof h5wasm.File>, path: string): Dataset {
  const entity = file.get(path);
  if (!isDataset(entity)) {
    throw new Error(`Dataset not found: ${path}`);
  }
  return entity;
}

function findVariable(summary: NetCDFSummary, nameOrPath: string): VariableSummary {
  const variable = summary.variables.find(
    (candidate) => candidate.name === nameOrPath || candidate.path === nameOrPath
  );
  if (!variable) {
    throw new Error(`Variable not found: ${nameOrPath}`);
  }
  return variable;
}

function isRenderableDataVariable(
  variable: VariableSummary,
  latVariable?: VariableSummary,
  lonVariable?: VariableSummary
): boolean {
  if (!latVariable || !lonVariable || variable.isCoordinateVariable) {
    return false;
  }
  if (variable.name === latVariable.name || variable.name === lonVariable.name) {
    return false;
  }
  if (!isNumericDtype(variable.type) || variable.dimensions.length < 2) {
    return false;
  }
  return findDimensionPosition(variable, latVariable) >= 0 && findDimensionPosition(variable, lonVariable) >= 0;
}

function findDimensionPosition(variable: VariableSummary, coordinateVariable: VariableSummary): number {
  const coordinateDimension = coordinateVariable.dimensions[0];
  if (!coordinateDimension) {
    return -1;
  }
  return variable.dimensions.findIndex((dimension) => dimension.name === coordinateDimension.name);
}

function isLatitudeVariable(variable: VariableSummary): boolean {
  const units = String(variable.attributes.units ?? "").toLowerCase();
  const standardName = String(variable.attributes.standard_name ?? "").toLowerCase();
  return isLatLike(variable.name) || standardName === "latitude" || units.includes("degrees_north");
}

function isLongitudeVariable(variable: VariableSummary): boolean {
  const units = String(variable.attributes.units ?? "").toLowerCase();
  const standardName = String(variable.attributes.standard_name ?? "").toLowerCase();
  return isLonLike(variable.name) || standardName === "longitude" || units.includes("degrees_east");
}

function isLatLike(name: string): boolean {
  return LAT_NAMES.has(name.toLowerCase());
}

function isLonLike(name: string): boolean {
  return LON_NAMES.has(name.toLowerCase());
}

function isCoordinateVariableName(name: string): boolean {
  return COORDINATE_NAMES.has(name.toLowerCase());
}

function isNumericDtype(dtype: string): boolean {
  return /[bBhHiIlLqQfFd]/.test(dtype);
}

function numericArray(values: OutputData | null): number[] {
  if (!values || typeof values === "string" || typeof values === "number" || typeof values === "bigint" || typeof values === "boolean") {
    return [];
  }
  return Array.from(values as ArrayLike<unknown>, (value) =>
    typeof value === "number" ? value : Number.NaN
  );
}

function numericAttribute(attrs: Record<string, unknown>, name: string): number | undefined {
  const value = attrs[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function arrayAttribute(attrs: Record<string, unknown>, name: string): [number, number] | undefined {
  const value = attrs[name];
  if (Array.isArray(value) && value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
    return [value[0], value[1]];
  }
  return undefined;
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

function isDataset(entity: Entity | null): entity is Dataset {
  return entity instanceof h5wasm.Dataset;
}

function isGroup(entity: Entity | null): entity is Group {
  return entity instanceof h5wasm.Group;
}
