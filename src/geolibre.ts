import "./styles.css";
import {
  closeNetCDF,
  getDefaultFixedDimensions,
  summarizeNetCDF,
  toRasterGrid,
  variableLabel
} from "./netcdf";
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
  layerMode: LayerMode;
}

const state: PluginState = {
  fixedDimensions: {},
  maxPixels: 1000000,
  colormap: "temperature",
  opacity: 0.82,
  layerMode: "geolibre"
};

type ColorMapName = "temperature" | "viridis" | "turbo" | "blueRed" | "grayscale";
type LayerMode = "geolibre" | "direct";

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
const generatedRasterOverlays: GeneratedRasterOverlay[] = [];

interface GeneratedRasterOverlay {
  sourceId: string;
  layerId: string;
  identifySourceId?: string;
  identifyLayerId?: string;
  name: string;
  registered: boolean;
}

export const plugin: GeoLibrePlugin = {
  id: PLUGIN_ID,
  name: "NetCDF Loader",
  version: "0.5.3",
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
    unregisterRegisteredRasterOverlays(app);
    removeAllGeneratedRasterOverlays(app.getMap?.());
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
    state.layerMode = projectState.layerMode ?? "geolibre";
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
    closeNetCDF(this.summary);
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
      await this.loadArrayBuffer(arrayBuffer, url.href);
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

    const status = el("div", "geolibre-netcdf__status", "Choose a NetCDF4/HDF5 file to inspect.");
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
      `NetCDF4/HDF5, ${this.summary.dimensions.length} dimensions, ${this.summary.variables.length} datasets`
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

      const layerModeLabel = el("label", "geolibre-netcdf__label", "Layer mode");
      const layerModeSelect = document.createElement("select");
      const geolibreOption = document.createElement("option");
      geolibreOption.value = "geolibre";
      geolibreOption.textContent = "GeoLibre layer (left panel)";
      const directOption = document.createElement("option");
      directOption.value = "direct";
      directOption.textContent = "Direct raster overlay";
      layerModeSelect.append(geolibreOption, directOption);
      layerModeSelect.value = this.pluginState.layerMode;
      layerModeSelect.addEventListener("change", () => {
        this.pluginState.layerMode = layerModeSelect.value as LayerMode;
      });
      layerModeLabel.append(layerModeSelect);

      dataset.append(colorLabel, opacityLabel, maxLabel, layerModeLabel);
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
    this.renderOverlayControls();
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
      await this.loadArrayBuffer(await file.arrayBuffer(), file.name);
    } catch (error) {
      this.setStatus(errorMessage(error), "error");
    }
  }

  private async loadArrayBuffer(arrayBuffer: ArrayBuffer, sourceLabel: string): Promise<void> {
    try {
      closeNetCDF(this.summary);
      this.summary = await summarizeNetCDF(arrayBuffer);
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
      const raster = await toRasterGrid(this.summary, {
        variableName: variable.name,
        fixedDimensions: this.pluginState.fixedDimensions,
        maxPixels: this.pluginState.maxPixels
      });
      const layerName = `${variable.name} raster from ${this.pluginState.sourceLabel ?? "NetCDF"}`;
      const result = await this.addRasterLayer(layerName, raster);
      this.app.fitBounds?.(raster.bounds);
      this.renderLegend(raster);
      this.renderOverlayControls();
      const sampling =
        raster.sampledEvery > 1 ? ` Sampled every ${raster.sampledEvery} grid cells.` : "";
      const mode = result.mode === "registered" ? "Added GeoLibre raster layer" : "Added direct raster overlay";
      const note =
        result.mode === "maplibre"
          ? " Managed from this plugin panel; direct overlays are not visible in GeoLibre's Layers panel."
          : "";
      this.setStatus(
        `${mode} ${result.layerId} (${raster.width} x ${raster.height}, ${raster.validValueCount} cells).${sampling}${note}`,
        "ok"
      );
    } catch (error) {
      this.setStatus(errorMessage(error), "error");
    }
  }

  private async addRasterLayer(
    layerName: string,
    raster: RasterGridResult
  ): Promise<{ layerId: string; mode: "registered" | "maplibre" }> {
    if (this.pluginState.layerMode === "direct") {
      return this.addMapLibreRasterOverlay(layerName, raster);
    }

    return this.addRegisteredRasterOverlay(layerName, raster);
  }

  private addRegisteredRasterOverlay(
    layerName: string,
    raster: RasterGridResult
  ): { layerId: string; mode: "registered" } {
    if (!this.app.registerExternalNativeLayer) {
      throw new Error(
        "This GeoLibre build does not expose registerExternalNativeLayer, so the plugin cannot create a Layers-panel raster entry."
      );
    }
    const map = this.app.getMap?.();
    if (!map) {
      throw new Error(
        "This GeoLibre build does not expose direct map access, so the plugin cannot add a registered raster layer."
      );
    }

    const canvas = renderRasterToCanvas(raster, this.pluginState.colormap);
    const overlay = addRasterCanvasLayer(map, layerName, canvas, raster, this.pluginState.opacity);
    const identifyOverlay = addRasterIdentifyLayer(map, layerName, raster, overlay.layerId);
    generatedRasterOverlays.push({
      ...overlay,
      identifySourceId: identifyOverlay.sourceId,
      identifyLayerId: identifyOverlay.layerId,
      name: layerName,
      registered: true
    });
    this.app.registerExternalNativeLayer({
      id: overlay.layerId,
      name: layerName,
      type: "raster",
      source: {
        type: "canvas",
        sourceId: overlay.sourceId,
        variable: raster.variableName
      },
      sourceId: overlay.sourceId,
      sourceIds: [overlay.sourceId, identifyOverlay.sourceId],
      nativeLayerIds: [overlay.layerId, identifyOverlay.layerId],
      opacity: this.pluginState.opacity,
      metadata: {
        sourceKind: "geolibre-netcdf-raster",
        pluginId: PLUGIN_ID,
        externalNativeLayer: true,
        controlOwnsPaint: true,
        identifiable: true
      }
    });
    return { layerId: overlay.layerId, mode: "registered" };
  }

  private addMapLibreRasterOverlay(
    layerName: string,
    raster: RasterGridResult
  ): { layerId: string; mode: "maplibre" } {
    const map = this.app.getMap?.();
    if (!map) {
      throw new Error(
        "This GeoLibre build does not expose direct map access, so the plugin cannot add a direct raster overlay."
      );
    }

    const canvas = renderRasterToCanvas(raster, this.pluginState.colormap);
    const overlay = addRasterCanvasLayer(map, layerName, canvas, raster, this.pluginState.opacity);
    generatedRasterOverlays.push({ ...overlay, name: layerName, registered: false });
    return { layerId: overlay.layerId, mode: "maplibre" };
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

  private renderOverlayControls(): void {
    const dataset = this.container?.querySelector(".geolibre-netcdf__dataset");
    if (!dataset) {
      return;
    }
    dataset.querySelector(".geolibre-netcdf__overlays")?.remove();
    const directOverlays = generatedRasterOverlays.filter((overlay) => !overlay.registered);
    if (directOverlays.length === 0) {
      return;
    }

    const controls = el("div", "geolibre-netcdf__overlays");
    controls.append(el("h4", "", "Map raster overlays"));
    for (const overlay of directOverlays) {
      const row = el("div", "geolibre-netcdf__overlay-row");
      row.append(el("span", "", overlay.name));
      row.append(
        button("Remove", () => {
          removeGeneratedRasterOverlay(this.app.getMap?.(), overlay.layerId);
          this.renderOverlayControls();
        })
      );
      controls.append(row);
    }
    dataset.append(controls);
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

function addRasterCanvasLayer(
  map: GeoLibreMapLike,
  name: string,
  canvas: HTMLCanvasElement,
  raster: RasterGridResult,
  opacity: number
): { sourceId: string; layerId: string } {
  const suffix = `${Date.now()}-${Math.round(Math.random() * 100000)}`;
  const sourceId = `netcdf-raster-source-${suffix}`;
  const layerId = `netcdf-raster-layer-${suffix}`;
  const [west, south, east, north] = raster.bounds;

  map.addSource(sourceId, {
    type: "canvas",
    canvas,
    coordinates: [
      [west, north],
      [east, north],
      [east, south],
      [west, south]
    ],
    animate: false
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
      "raster-opacity": Math.max(0, Math.min(1, opacity)),
      "raster-resampling": "nearest"
    }
  });

  return { sourceId, layerId };
}

function addRasterIdentifyLayer(
  map: GeoLibreMapLike,
  name: string,
  raster: RasterGridResult,
  rasterLayerId: string
): { sourceId: string; layerId: string } {
  const sourceId = `${rasterLayerId}-identify-source`;
  const layerId = `${rasterLayerId}-identify`;
  map.addSource(sourceId, {
    type: "geojson",
    data: rasterToIdentifyFeatureCollection(raster)
  });
  map.addLayer({
    id: layerId,
    type: "fill",
    source: sourceId,
    metadata: {
      "geolibre:displayName": `${name} identify cells`,
      "geolibre:plugin": PLUGIN_ID
    },
    paint: {
      "fill-color": "#000000",
      "fill-opacity": 0
    }
  });
  return { sourceId, layerId };
}

function rasterToIdentifyFeatureCollection(raster: RasterGridResult): FeatureCollection {
  const features: FeatureCollection["features"] = [];
  const lonEdges = centersToEdges(raster.lonCenters, raster.bounds[0], raster.bounds[2]);
  const latEdges = centersToEdges(raster.latCenters, raster.bounds[3], raster.bounds[1]);

  for (let row = 0; row < raster.height; row += 1) {
    const north = latEdges[row];
    const south = latEdges[row + 1];
    const minLat = Math.min(south, north);
    const maxLat = Math.max(south, north);
    for (let column = 0; column < raster.width; column += 1) {
      const value = raster.values[row * raster.width + column];
      if (!Number.isFinite(value)) {
        continue;
      }
      const west = lonEdges[column];
      const east = lonEdges[column + 1];
      const minLon = Math.min(west, east);
      const maxLon = Math.max(west, east);
      features.push({
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [minLon, minLat],
              [maxLon, minLat],
              [maxLon, maxLat],
              [minLon, maxLat],
              [minLon, minLat]
            ]
          ]
        },
        properties: {
          variable: raster.variableName,
          value,
          row,
          column,
          longitude: raster.lonCenters[column],
          latitude: raster.latCenters[row],
          sampled_every: raster.sampledEvery
        }
      });
    }
  }

  return { type: "FeatureCollection", features };
}

function centersToEdges(centers: number[], firstFallback: number, lastFallback: number): number[] {
  if (centers.length === 0) {
    return [firstFallback, lastFallback];
  }
  if (centers.length === 1) {
    return [firstFallback, lastFallback];
  }

  const edges = new Array<number>(centers.length + 1);
  edges[0] = firstFallback;
  for (let index = 1; index < centers.length; index += 1) {
    edges[index] = (centers[index - 1] + centers[index]) / 2;
  }
  edges[centers.length] = lastFallback;
  return edges;
}

function renderRasterToCanvas(raster: RasterGridResult, colorMapName: ColorMapName): HTMLCanvasElement {
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
  return canvas;
}

function removeGeneratedRasterOverlay(map: GeoLibreMapLike | undefined, layerId: string): void {
  const index = generatedRasterOverlays.findIndex((overlay) => overlay.layerId === layerId);
  if (index < 0) {
    return;
  }
  const [overlay] = generatedRasterOverlays.splice(index, 1);
  try {
    if (overlay.identifyLayerId && map?.getLayer(overlay.identifyLayerId)) {
      map.removeLayer(overlay.identifyLayerId);
    }
    if (map?.getLayer(overlay.layerId)) {
      map.removeLayer(overlay.layerId);
    }
    if (overlay.identifySourceId && map?.getSource(overlay.identifySourceId)) {
      map.removeSource(overlay.identifySourceId);
    }
    if (map?.getSource(overlay.sourceId)) {
      map.removeSource(overlay.sourceId);
    }
  } catch {
    // If GeoLibre already reset the map style, the overlay may already be gone.
  }
}

function removeAllGeneratedRasterOverlays(map: GeoLibreMapLike | undefined): void {
  for (const overlay of [...generatedRasterOverlays]) {
    removeGeneratedRasterOverlay(map, overlay.layerId);
  }
}

function unregisterRegisteredRasterOverlays(app: GeoLibreAppAPI): void {
  for (const overlay of generatedRasterOverlays.filter((entry) => entry.registered)) {
    app.unregisterExternalNativeLayer?.(overlay.layerId);
  }
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
