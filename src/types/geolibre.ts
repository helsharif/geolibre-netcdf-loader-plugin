export type GeoLibreMapControlPosition =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export interface GeoLibrePlugin {
  id: string;
  name: string;
  version: string;
  activeByDefault?: boolean;
  urlParameterNames?: string[];
  activate: (app: GeoLibreAppAPI) => boolean | void;
  deactivate: (app: GeoLibreAppAPI) => void;
  handleUrlParameters?: (
    app: GeoLibreAppAPI,
    params: URLSearchParams
  ) => void | Promise<void>;
  getProjectState?: () => unknown;
  applyProjectState?: (app: GeoLibreAppAPI, state: unknown) => boolean | void;
}

export interface GeoLibreAppAPI {
  addGeoJsonLayer: (
    name: string,
    data: FeatureCollection,
    sourcePath?: string
  ) => string;
  fetchArrayBuffer?: (url: string) => Promise<ArrayBuffer>;
  fitBounds?: (bounds: [number, number, number, number]) => void;
  getMap?: () => GeoLibreMapLike;
  addMapControl?: (
    control: GeoLibreMapControl,
    position?: GeoLibreMapControlPosition
  ) => boolean;
  removeMapControl?: (control: GeoLibreMapControl) => void;
  registerRightPanel?: (panel: GeoLibreRightPanelRegistration) => () => void;
  unregisterRightPanel?: (id: string) => void;
  openRightPanel?: (id: string) => boolean;
  closeRightPanel?: (id: string) => void;
  registerToolbarMenu?: (menu: GeoLibreToolbarMenu) => () => void;
  unregisterToolbarMenu?: (id: string) => void;
}

export interface GeoLibreMapControl {
  onAdd: (map: unknown) => HTMLElement;
  onRemove: () => void;
}

export interface GeoLibreMapLike {
  addSource: (id: string, source: unknown) => void;
  removeSource: (id: string) => void;
  getSource: (id: string) => unknown;
  addLayer: (layer: unknown, beforeId?: string) => void;
  removeLayer: (id: string) => void;
  getLayer: (id: string) => unknown;
  setPaintProperty?: (layerId: string, name: string, value: unknown) => void;
}

export interface GeoLibreRightPanelRegistration {
  id: string;
  title: string;
  dock?: "left-of-layers" | "right-of-layers" | "left-of-style" | "right-of-style";
  icon?: string;
  defaultWidth?: number;
  render: (container: HTMLElement) => void | (() => void);
  onOpen?: () => void;
  onCollapse?: () => void;
  onClose?: () => void;
}

export interface GeoLibreToolbarMenu {
  id: string;
  label: string;
  icon?: string;
  items: GeoLibreToolbarMenuItem[];
}

export type GeoLibreToolbarMenuItem =
  | {
      type?: "action";
      id: string;
      label: string;
      icon?: string;
      disabled?: boolean;
      onSelect: () => void;
    }
  | {
      type: "submenu";
      id: string;
      label: string;
      icon?: string;
      items: GeoLibreToolbarMenuItem[];
    }
  | { type: "separator"; id?: string };

export interface FeatureCollection {
  type: "FeatureCollection";
  features: Feature[];
}

export interface Feature {
  type: "Feature";
  geometry:
    | {
        type: "Point";
        coordinates: [number, number];
      }
    | {
        type: "Polygon";
        coordinates: Array<Array<[number, number]>>;
      };
  properties: Record<string, string | number | null>;
}
