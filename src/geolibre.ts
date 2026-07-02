import "./styles.css";
import {
  getDefaultFixedDimensions,
  summarizeNetCDF,
  toPointFeatureCollection,
  toRasterGrid,
  variableLabel
} from "./netcdf";
import { rasterGridToGeoTiffBlob } from "./geotiff";
import type {
  FeatureCollection,
  GeoLibreAppAPI,
  GeoLibreMapControl,
  GeoLibreMapLike,
  GeoLibrePlugin
} from "./types/geolibre";
import type { NetCDFSummary, RasterGridResult, VariableSummary } from "./netcdf";

const PLUGIN_ID = "geolibre-netcdf";
const PANEL_ID = "geolibre-netcdf-panel";
const MENU_ID = "geolibre-netcdf-menu";
const NETCDF_URL_PARAM = "netcdfUrl";

interface PluginState {
  sourceLabel?: string;
  selectedVariable?: string;
  fixedDimensions: Record<string, number>;
  maxPixels: number;
  colormap: ColorMapName;
  opacity: number;
}

const state: PluginState = {
  fixedDimensions: {},
  maxPixels: 1000000,
  colormap: "temperature",
  opacity: 0.82
};

type ColorMapName = "temperature" | "viridis" | "turbo" | "blueRed" | "grayscale";

const COLOR_MAPS: Record<ColorMapName, { label: string; stops: Array<[number, string]> }> = {
  temperature: {
    label: "Temperature",
    stops: [
      [0, "#253494"],
      [0.18, "#2c7fb8"],
      [0.36, "#41b6c4"],
      [0.5, "#ffffbf"],
      [0.66, "#fdae61"],
      [0.82, "#f46d43"],
      [1, "#a50026"]
    ]
  },
  viridis: {
    label: "Viridis",
    stops: [
      [0, "#440154"],
      [0.25, "#3b528b"],
      [0.5, "#21918c"],
      [0.75, "#5ec962"],
      [1, "#fde725"]
    ]
  },
  turbo: {
    label: "Turbo",
    stops: [
      [0, "#30123b"],
      [0.18, "#466be3"],
      [0.36, "#35b779"],
      [0.54, "#f4e61e"],
      [0.72, "#f98c10"],
      [0.9, "#c42203"],
      [1, "#7a0403"]
    ]
  },
  blueRed: {
    label: "Blue-red",
    stops: [
      [0, "#313695"],
      [0.5, "#ffffbf"],
      [1, "#a50026"]
    ]
  },
  grayscale: {
    label: "Grayscale",
    stops: [
      [0, "#111827"],
      [1, "#f9fafb"]
    ]
  }
};

let unregisterPanel: (() => void) | undefined;
let unregisterMenu: (() => void) | undefined;
let panelView: NetCDFPanel | undefined;
let mapControl: NetCDFMapControl | undefined;
let floatingPanel: HTMLElement | undefined;
let floatingPanelView: NetCDFPanel | undefined;
const generatedRasterUrls: string[] = [];

export const plugin: GeoLibrePlugin = {
  id: PLUGIN_ID,
  name: "NetCDF Loader",
  version: "0.3.1",
  urlParameterNames: [NETCDF_URL_PARAM],
  activate(app) {
    unregisterPanel = app.registerRightPanel?.({
      id: PANEL_ID,
      title: "NetCDF",
      dock: "right-of-style",
      defaultWidth: 380,
      render(container) {
        panelView = new NetCDFPanel(app, state);
        panelView.render(container);
        return () => {
          panelView?.destroy();
          panelView = undefined;
        };
      }
    });

    unregisterMenu = app.registerToolbarMenu?.({
      id: MENU_ID,
      label: "NetCDF",
      items: [
        {
          id: "open-panel",
          label: "Open NetCDF panel",
          onSelect: () => app.openRightPanel?.(PANEL_ID)
        }
      ]
    });

    mapControl = new NetCDFMapControl(() => openNetCDFPanel(app));
    app.addMapControl?.(mapControl, "top-right");
    app.openRightPanel?.(PANEL_ID);
  },
  deactivate(app) {
    app.closeRightPanel?.(PANEL_ID);
    if (mapControl) {
      app.removeMapControl?.(mapControl);
    }
    revokeGeneratedRasterUrls();
    closeFloatingPanel();
    unregisterMenu?.();
    unregisterPanel?.();
    app.unregisterToolbarMenu?.(MENU_ID);
    app.unregisterRightPanel?.(PANEL_ID);
    unregisterMenu = undefined;
    unregisterPanel = undefined;
    mapControl = undefined;
    panelView = undefined;
  },
  async handleUrlParameters(app, params) {
    const url = params.get(NETCDF_URL_PARAM);
    if (!url) {
      return;
    }
    openNetCDFPanel(app);
    await (panelView ?? floatingPanelView)?.loadFromUrl(url);
  },
  getProjectState() {
    return { ...state, fixedDimensions: { ...state.fixedDimensions } };
  },
  applyProjectState(_app, projectState) {
    if (!isPluginState(projectState)) {
      return false;
    }
    state.sourceLabel = projectState.sourceLabel;
    state.selectedVariable = projectState.selectedVariable;
    state.fixedDimensions = { ...projectState.fixedDimensions };
    state.maxPixels = projectState.maxPixels;
    state.colormap = projectState.colormap;
    state.opacity = projectState.opacity;
    return true;
  }
};

export default plugin;

class NetCDFMapControl implements GeoLibreMapControl {
  private container?: HTMLElement;

  constructor(private readonly onOpen: () => void) {}

  onAdd(): HTMLElement {
    const container = document.createElement("div");
    container.className = "maplibregl-ctrl maplibregl-ctrl-group geolibre-netcdf-control";
    const buttonElement = document.createElement("button");
    buttonElement.type = "button";
    buttonElement.title = "Open NetCDF Loader";
    buttonElement.setAttribute("aria-label", "Open NetCDF Loader");
    buttonElement.textContent = "NC";
    buttonElement.addEventListener("click", this.onOpen);
    container.append(buttonElement);
    this.container = container;
    return container;
  }

  onRemove(): void {
    this.container?.remove();
    this.container = undefined;
  }
}

class NetCDFPanel {
  private container?: HTMLElement;
  private summary?: NetCDFSummary;
  private abortController?: AbortController;

  constructor(
    private readonly app: GeoLibreAppAPI,
    private readonly pluginState: PluginState
  ) {}

  render(container: HTMLElement): void {
    this.container = container;
    container.className = "geolibre-netcdf";
    this.draw();
  }

  destroy(): void {
    this.abortController?.abort();
  }

  async loadFromUrl(urlText: string): Promise<void> {
    const url = parseHttpsUrl(urlText);
    if (!url) {
      this.setStatus("Enter an HTTPS NetCDF URL.", "error");
      return;
    }

    this.abortController?.abort();
    this.abortController = new AbortController();
    this.setStatus(`Loading ${url.href}`, "busy");

    try {
      const arrayBuffer = this.app.fetchArrayBuffer
        ? await this.app.fetchArrayBuffer(url.href)
        : await fetchArrayBuffer(url.href, this.abortController.signal);
      this.loadArrayBuffer(arrayBuffer, url.href);
    } catch (error) {
      this.setStatus(errorMessage(error), "error");
    }
  }

  private draw(): void {
    if (!this.container) {
      return;
    }

    this.container.innerHTML = "";
    const localSection = el("section", "geolibre-netcdf__section");
    const fileLabel = el("label", "geolibre-netcdf__label", "Local NetCDF file");
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".nc,.cdf,.netcdf,application/x-netcdf";
    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      if (file) {
        void this.loadFile(file);
      }
    });
    fileLabel.append(fileInput);
    localSection.append(fileLabel);

    const urlSection = el("section", "geolibre-netcdf__section");
    const urlLabel = el("label", "geolibre-netcdf__label", "HTTPS NetCDF URL");
    const urlRow = el("div", "geolibre-netcdf__row");
    const urlInput = document.createElement("input");
    urlInput.type = "url";
    urlInput.placeholder = "https://example.org/data.nc";
    const loadUrlButton = button("Load", () => void this.loadFromUrl(urlInput.value));
    urlRow.append(urlInput, loadUrlButton);
    urlLabel.append(urlRow);
    urlSection.append(urlLabel);

    const status = el("div", "geolibre-netcdf__status", "Choose a NetCDF v3 file to inspect.");
    status.dataset.role = "status";

    this.container.append(localSection, urlSection, status);

    if (this.summary) {
      this.renderSummary();
    }
  }

  private renderSummary(): void {
    if (!this.container || !this.summary) {
      return;
    }

    const existing = this.container.querySelector(".geolibre-netcdf__dataset");
    existing?.remove();

    const dataset = el("section", "geolibre-netcdf__dataset");
    const title = el("h3", "", this.pluginState.sourceLabel ?? "Loaded dataset");
    const meta = el(
      "p",
      "geolibre-netcdf__muted",
      `${this.summary.format.toUpperCase()}, ${this.summary.dimensions.length} dimensions, ${this.summary.variables.length} variables`
    );

    const variableLabelElement = el("label", "geolibre-netcdf__label", "Variable");
    const variableSelect = document.createElement("select");
    for (const variable of this.summary.dataVariables) {
      const option = document.createElement("option");
      option.value = variable.name;
      option.textContent = variableLabel(variable);
      variableSelect.append(option);
    }
    variableSelect.value =
      this.pluginState.selectedVariable ?? this.summary.dataVariables[0]?.name ?? "";
    variableSelect.addEventListener("change", () => {
      this.pluginState.selectedVariable = variableSelect.value;
      const variable = this.selectedVariable();
      this.pluginState.fixedDimensions = variable
        ? getDefaultFixedDimensions(variable)
        : {};
      this.renderSummary();
    });
    variableLabelElement.append(variableSelect);

    dataset.append(title, meta, variableLabelElement);

    const selectedVariable = this.selectedVariable();
    if (selectedVariable) {
      dataset.append(this.renderSliceControls(selectedVariable));
      const colorLabel = el("label", "geolibre-netcdf__label", "Colormap");
      const colorSelect = document.createElement("select");
      for (const [name, colorMap] of Object.entries(COLOR_MAPS)) {
        const option = document.createElement("option");
        option.value = name;
        option.textContent = colorMap.label;
        colorSelect.append(option);
      }
      colorSelect.value = this.pluginState.colormap;
      colorSelect.addEventListener("change", () => {
        this.pluginState.colormap = colorSelect.value as ColorMapName;
      });
      colorLabel.append(colorSelect, renderColorRamp(this.pluginState.colormap));

      const opacityLabel = el(
        "label",
        "geolibre-netcdf__label",
        `Opacity (${Math.round(this.pluginState.opacity * 100)}%)`
      );
      const opacityInput = document.createElement("input");
      opacityInput.type = "range";
      opacityInput.min = "0";
      opacityInput.max = "1";
      opacityInput.step = "0.05";
      opacityInput.value = String(this.pluginState.opacity);
      opacityInput.addEventListener("input", () => {
        this.pluginState.opacity = Number(opacityInput.value) || 0.82;
        opacityLabel.firstChild!.textContent = `Opacity (${Math.round(this.pluginState.opacity * 100)}%)`;
      });
      opacityLabel.append(opacityInput);

      const maxLabel = el("label", "geolibre-netcdf__label", "Maximum raster pixels");
      const maxInput = document.createElement("input");
      maxInput.type = "number";
      maxInput.min = "10000";
      maxInput.step = "10000";
      maxInput.value = String(this.pluginState.maxPixels);
      maxInput.addEventListener("change", () => {
        this.pluginState.maxPixels = Number(maxInput.value) || 1000000;
      });
      maxLabel.append(maxInput);
      dataset.append(colorLabel, opacityLabel, maxLabel);
    }

    const addButton = button("Add raster layer", () => void this.addLayer());
    addButton.disabled = !selectedVariable;
    dataset.append(addButton);

    if (this.summary.dataVariables.length === 0) {
      dataset.append(
        el(
          "p",
          "geolibre-netcdf__status geolibre-netcdf__status--error",
          "No renderable variable uses the detected latitude and longitude dimensions."
        )
      );
    }

    this.container.append(dataset);
  }

  private renderSliceControls(variable: VariableSummary): HTMLElement {
    const wrapper = el("div", "geolibre-netcdf__slice");
    for (const dimension of variable.dimensions) {
      if (isSpatialDimension(dimension.name)) {
        continue;
      }
      const label = el(
        "label",
        "geolibre-netcdf__label",
        `${dimension.name} index (0-${Math.max(0, dimension.size - 1)})`
      );
      const input = document.createElement("input");
      input.type = "number";
      input.min = "0";
      input.max = String(Math.max(0, dimension.size - 1));
      input.step = "1";
      input.value = String(this.pluginState.fixedDimensions[dimension.name] ?? 0);
      input.addEventListener("change", () => {
        this.pluginState.fixedDimensions[dimension.name] = Number(input.value) || 0;
      });
      label.append(input);
      wrapper.append(label);
    }
    return wrapper;
  }

  private async loadFile(file: File): Promise<void> {
    this.setStatus(`Reading ${file.name}`, "busy");
    try {
      this.loadArrayBuffer(await file.arrayBuffer(), file.name);
    } catch (error) {
      this.setStatus(errorMessage(error), "error");
    }
  }

  private loadArrayBuffer(arrayBuffer: ArrayBuffer, sourceLabel: string): void {
    try {
      this.summary = summarizeNetCDF(arrayBuffer);
      this.pluginState.sourceLabel = sourceLabel;
      this.pluginState.selectedVariable = this.summary.dataVariables[0]?.name;
      const selected = this.selectedVariable();
      this.pluginState.fixedDimensions = selected ? getDefaultFixedDimensions(selected) : {};
      this.draw();
      this.setStatus("Dataset loaded.", "ok");
    } catch (error) {
      this.setStatus(errorMessage(error), "error");
    }
  }

  private async addLayer(): Promise<void> {
    if (!this.summary) {
      this.setStatus("Load a dataset first.", "error");
      return;
    }
    const variable = this.selectedVariable();
    if (!variable) {
      this.setStatus("Choose a variable first.", "error");
      return;
    }

    try {
      const raster = toRasterGrid(this.summary, {
        variableName: variable.name,
        fixedDimensions: this.pluginState.fixedDimensions,
        maxPixels: this.pluginState.maxPixels
      });
      const layerName = `${variable.name} raster from ${this.pluginState.sourceLabel ?? "NetCDF"}`;
      const result = this.app.addCogLayer
        ? await this.addNativeRasterLayer(layerName, raster)
        : this.addVectorRasterFallback(layerName, raster, "GeoLibre host does not expose addCogLayer.");
      this.app.fitBounds?.(raster.bounds);
      this.renderLegend(raster);
      const sampling =
        raster.sampledEvery > 1 ? ` Sampled every ${raster.sampledEvery} grid cells.` : "";
      const mode =
        result.mode === "native"
          ? "Added native raster layer"
          : `Added vector fallback (${result.reason})`;
      this.setStatus(
        `${mode} ${result.layerId} (${raster.width} x ${raster.height}, ${raster.validValueCount} cells).${sampling}`,
        result.mode === "native" ? "ok" : "busy"
      );
    } catch (error) {
      try {
        this.addPointFallback(variable);
        this.setStatus(`${errorMessage(error)} Added points as a fallback.`, "error");
      } catch (fallbackError) {
        this.setStatus(`${errorMessage(error)} Fallback also failed: ${errorMessage(fallbackError)}`, "error");
      }
    }
  }

  private async addNativeRasterLayer(
    layerName: string,
    raster: RasterGridResult
  ): Promise<{ layerId: string; mode: "native" | "fallback"; reason?: string }> {
    if (!this.app.addCogLayer) {
      return this.addVectorRasterFallback(layerName, raster, "GeoLibre host does not expose addCogLayer.");
    }

    try {
      const blob = rasterGridToGeoTiffBlob(raster);
      const url = URL.createObjectURL(blob);
      generatedRasterUrls.push(url);
      const layerId = await this.app.addCogLayer(layerName, url, {
        bands: "1",
        colormap: toCogColorMap(this.pluginState.colormap),
        rescaleMin: raster.valueRange[0],
        rescaleMax: raster.valueRange[1],
        nodata: Number.NaN,
        opacity: this.pluginState.opacity
      });
      return { layerId, mode: "native" };
    } catch (error) {
      return this.addVectorRasterFallback(layerName, raster, `addCogLayer failed: ${errorMessage(error)}`);
    }
  }

  private addVectorRasterFallback(
    layerName: string,
    raster: RasterGridResult,
    reason: string
  ): { layerId: string; mode: "fallback"; reason: string } {
    const gridLayer = rasterToCellFeatureCollection(raster, this.pluginState.colormap);
    const layerId = this.app.addGeoJsonLayer(layerName, gridLayer, this.pluginState.sourceLabel);
    styleCellLayer(this.app.getMap?.() ?? undefined, layerId, this.pluginState.opacity);
    return { layerId, mode: "fallback", reason };
  }

  private addPointFallback(variable: VariableSummary): void {
    if (!this.summary) {
      return;
    }
    const result = toPointFeatureCollection(this.summary, {
      variableName: variable.name,
      fixedDimensions: this.pluginState.fixedDimensions,
      maxFeatures: Math.min(this.pluginState.maxPixels, 20000)
    });
    const layerName = `${variable.name} points from ${this.pluginState.sourceLabel ?? "NetCDF"}`;
    this.app.addGeoJsonLayer(layerName, result.collection, this.pluginState.sourceLabel);
    this.app.fitBounds?.(result.bounds);
  }

  private renderLegend(raster: RasterGridResult): void {
    const dataset = this.container?.querySelector(".geolibre-netcdf__dataset");
    if (!dataset) {
      return;
    }
    dataset.querySelector(".geolibre-netcdf__legend")?.remove();
    const legend = el("div", "geolibre-netcdf__legend");
    const ramp = renderColorRamp(this.pluginState.colormap);
    const labels = el("div", "geolibre-netcdf__legend-labels");
    labels.append(
      el("span", "", formatNumber(raster.valueRange[0])),
      el("span", "", formatNumber(raster.valueRange[1]))
    );
    legend.append(ramp, labels);
    dataset.append(legend);
  }

  private selectedVariable(): VariableSummary | undefined {
    return this.summary?.dataVariables.find(
      (variable) => variable.name === this.pluginState.selectedVariable
    );
  }

  private setStatus(message: string, kind: "busy" | "error" | "ok"): void {
    const status = this.container?.querySelector<HTMLElement>("[data-role='status']");
    if (!status) {
      return;
    }
    status.textContent = message;
    status.className = `geolibre-netcdf__status geolibre-netcdf__status--${kind}`;
  }
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  element.addEventListener("click", onClick);
  return element;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  className = "",
  textContent = ""
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tagName);
  if (className) {
    element.className = className;
  }
  if (textContent) {
    element.textContent = textContent;
  }
  return element;
}

function isSpatialDimension(name: string): boolean {
  const normalized = name.toLowerCase();
  return ["lat", "latitude", "y", "nav_lat", "lon", "lng", "long", "longitude", "x", "nav_lon"].includes(
    normalized
  );
}

function rasterToCellFeatureCollection(
  raster: RasterGridResult,
  colorMapName: ColorMapName
): FeatureCollection {
  const lonEdges = centersToEdges(raster.lonCenters);
  const latEdges = centersToEdges(raster.latCenters);
  const [minValue, maxValue] = raster.valueRange;
  const span = maxValue - minValue || 1;
  const features: FeatureCollection["features"] = [];

  for (let row = 0; row < raster.height; row += 1) {
    const north = Math.max(latEdges[row], latEdges[row + 1]);
    const south = Math.min(latEdges[row], latEdges[row + 1]);
    for (let column = 0; column < raster.width; column += 1) {
      const value = raster.values[row * raster.width + column];
      if (!Number.isFinite(value)) {
        continue;
      }
      const west = Math.min(lonEdges[column], lonEdges[column + 1]);
      const east = Math.max(lonEdges[column], lonEdges[column + 1]);
      const color = rgbToCss(sampleColorMap(colorMapName, (value - minValue) / span));
      features.push({
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [west, south],
              [east, south],
              [east, north],
              [west, north],
              [west, south]
            ]
          ]
        },
        properties: {
          value,
          variable: raster.variableName,
          fill: color
        }
      });
    }
  }

  return { type: "FeatureCollection", features };
}

function centersToEdges(centers: number[]): number[] {
  if (centers.length === 0) {
    return [];
  }
  if (centers.length === 1) {
    return [centers[0] - 0.5, centers[0] + 0.5];
  }

  const edges = new Array<number>(centers.length + 1);
  for (let index = 1; index < centers.length; index += 1) {
    edges[index] = (centers[index - 1] + centers[index]) / 2;
  }
  edges[0] = centers[0] - (edges[1] - centers[0]);
  edges[centers.length] =
    centers[centers.length - 1] + (centers[centers.length - 1] - edges[centers.length - 1]);
  return edges;
}

function styleCellLayer(map: GeoLibreMapLike | undefined, layerId: string, opacity: number): void {
  const apply = () => {
    try {
      if (!map?.getLayer(layerId)) {
        return;
      }
      map.setPaintProperty?.(layerId, "fill-color", ["get", "fill"]);
      map.setPaintProperty?.(layerId, "fill-opacity", Math.max(0, Math.min(1, opacity)));
      map.setPaintProperty?.(layerId, "fill-outline-color", ["get", "fill"]);
    } catch {
      // GeoLibre may wrap the returned id or manage styling asynchronously.
    }
  };
  apply();
  window.setTimeout(apply, 250);
  window.setTimeout(apply, 1000);
}

function rgbToCss(color: [number, number, number]): string {
  return `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
}

function toCogColorMap(colorMapName: ColorMapName): string {
  const colorMaps: Record<ColorMapName, string> = {
    temperature: "spectral",
    viridis: "viridis",
    turbo: "turbo",
    blueRed: "rdylbu",
    grayscale: "gray"
  };
  return colorMaps[colorMapName];
}

function revokeGeneratedRasterUrls(): void {
  for (const url of generatedRasterUrls.splice(0)) {
    URL.revokeObjectURL(url);
  }
}

function addRasterImageLayer(
  map: GeoLibreMapLike,
  name: string,
  imageUrl: string,
  raster: RasterGridResult,
  opacity: number
): { sourceId: string; layerId: string } {
  const suffix = `${Date.now()}-${Math.round(Math.random() * 100000)}`;
  const sourceId = `netcdf-raster-source-${suffix}`;
  const layerId = `netcdf-raster-layer-${suffix}`;
  const [west, south, east, north] = raster.bounds;

  map.addSource(sourceId, {
    type: "image",
    url: imageUrl,
    coordinates: [
      [west, north],
      [east, north],
      [east, south],
      [west, south]
    ]
  });
  map.addLayer({
    id: layerId,
    type: "raster",
    source: sourceId,
    metadata: {
      "geolibre:displayName": name,
      "geolibre:plugin": PLUGIN_ID
    },
    paint: {
      "raster-opacity": Math.max(0, Math.min(1, opacity))
    }
  });

  return { sourceId, layerId };
}

function renderRasterToDataUrl(raster: RasterGridResult, colorMapName: ColorMapName): string {
  const canvas = document.createElement("canvas");
  canvas.width = raster.width;
  canvas.height = raster.height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Could not create a canvas for raster rendering.");
  }
  const image = context.createImageData(raster.width, raster.height);
  const [minValue, maxValue] = raster.valueRange;
  const span = maxValue - minValue || 1;

  for (let index = 0; index < raster.values.length; index += 1) {
    const value = raster.values[index];
    const offset = index * 4;
    if (!Number.isFinite(value)) {
      image.data[offset + 3] = 0;
      continue;
    }
    const color = sampleColorMap(colorMapName, (value - minValue) / span);
    image.data[offset] = color[0];
    image.data[offset + 1] = color[1];
    image.data[offset + 2] = color[2];
    image.data[offset + 3] = 225;
  }

  context.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png");
}

function renderColorRamp(colorMapName: ColorMapName): HTMLElement {
  const ramp = el("div", "geolibre-netcdf__ramp");
  ramp.style.background = `linear-gradient(90deg, ${COLOR_MAPS[colorMapName].stops
    .map(([position, color]) => `${color} ${Math.round(position * 100)}%`)
    .join(", ")})`;
  return ramp;
}

function sampleColorMap(colorMapName: ColorMapName, rawPosition: number): [number, number, number] {
  const position = Math.max(0, Math.min(1, rawPosition));
  const stops = COLOR_MAPS[colorMapName].stops;
  for (let index = 1; index < stops.length; index += 1) {
    const previous = stops[index - 1];
    const next = stops[index];
    if (position <= next[0]) {
      const local = (position - previous[0]) / (next[0] - previous[0] || 1);
      const previousRgb = hexToRgb(previous[1]);
      const nextRgb = hexToRgb(next[1]);
      return [
        interpolate(previousRgb[0], nextRgb[0], local),
        interpolate(previousRgb[1], nextRgb[1], local),
        interpolate(previousRgb[2], nextRgb[2], local)
      ];
    }
  }
  return hexToRgb(stops[stops.length - 1][1]);
}

function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function interpolate(start: number, end: number, position: number): number {
  return Math.round(start + (end - start) * position);
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toPrecision(4) : "n/a";
}

function openNetCDFPanel(app: GeoLibreAppAPI): void {
  const opened = app.openRightPanel?.(PANEL_ID);
  if (!opened) {
    openFloatingFallback(app);
  }
}

function openFloatingFallback(app: GeoLibreAppAPI): void {
  if (floatingPanel) {
    return;
  }

  floatingPanel = document.createElement("div");
  floatingPanel.className = "geolibre-netcdf-floating";

  const header = el("div", "geolibre-netcdf-floating__header", "NetCDF");
  const closeButton = button("Close", closeFloatingPanel);
  header.append(closeButton);

  const body = el("div", "geolibre-netcdf-floating__body");
  floatingPanelView = new NetCDFPanel(app, state);
  floatingPanelView.render(body);
  floatingPanel.append(header, body);
  document.body.append(floatingPanel);
}

function closeFloatingPanel(): void {
  floatingPanelView?.destroy();
  floatingPanel?.remove();
  floatingPanelView = undefined;
  floatingPanel = undefined;
}

async function fetchArrayBuffer(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Fetch failed with HTTP ${response.status}.`);
  }
  return response.arrayBuffer();
}

function parseHttpsUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPluginState(value: unknown): value is PluginState {
  if (!value || typeof value !== "object") {
    return false;
  }
  return (
    "fixedDimensions" in value &&
    "maxPixels" in value &&
    "colormap" in value &&
    "opacity" in value &&
    typeof (value as PluginState).maxPixels === "number" &&
    typeof (value as PluginState).colormap === "string" &&
    typeof (value as PluginState).opacity === "number"
  );
}
