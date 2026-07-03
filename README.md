# GeoLibre NetCDF Loader Plugin

GeoLibre NetCDF Loader Plugin adds NetCDF4/HDF5 climate-grid support to GeoLibre Desktop. It reads local or HTTPS NetCDF4 files, lets you choose a variable and 2D slice, and renders the result as a color-mapped raster.

Developed by **Husayn El Sharif**.

## Features

- Load local `.nc`, `.cdf`, and `.netcdf` files.
- Load HTTPS NetCDF files with the `?netcdfUrl=...` URL parameter.
- Detect classic NetCDF3/CDF files and explain that they are not supported in version 1.
- Read NetCDF4/HDF5 files with `h5wasm`.
- Detect common latitude and longitude coordinate variables.
- Render float and integer climate rasters, including packed unsigned integer grids with scale/offset metadata.
- Fetch HTTPS NetCDF files directly in the WebView to avoid large desktop IPC transfers.
- Select time slices with a date picker, previous/next controls, slider, and raw index field when CF time metadata is available.
- Select non-spatial dimension indexes such as `time`, `level`, or `depth`.
- Choose between a GeoLibre-registered raster layer that appears in the left Layers panel and a direct MapLibre raster overlay.
- Register plugin-owned raster layers with GeoLibre through `registerExternalNativeLayer`.
- Identify raster pixel values from GeoLibre's Layers-panel Identify tool with direct click-to-value sampling.
- Switch GeoLibre to Mercator while NetCDF rasters are active so canvas rasters align with the basemap.
- Render with Panoply-inspired color ramps:
  - Temperature
  - Viridis
  - Turbo
  - Blue-red
  - Grayscale
- Use direct MapLibre overlays as an explicit alternate rendering mode for visual debugging without layer-store registration.

## Rendering Approach

The default **GeoLibre layer (left panel)** mode renders the selected NetCDF slice as a MapLibre canvas raster layer, then registers that plugin-owned native layer with GeoLibre through `registerExternalNativeLayer`. GeoLibre's Identify button activates a plugin click sampler that converts the clicked longitude/latitude into a raster row and column, then reads the value directly from the typed array. Because MapLibre canvas rasters are planar sources, the plugin switches GeoLibre to Mercator while active and restores the previous projection when the plugin deactivates.

The **Direct raster overlay** mode renders the same slice into an in-memory canvas and registers it directly with MapLibre as a `canvas` source and `raster` layer. This is still raster rendering, not a vector fallback, but it bypasses GeoLibre's layer store, so direct overlays are managed from the plugin panel rather than the left Layers panel.

## Install

Download or build the plugin zip, then install it in GeoLibre Desktop:

1. Open **Settings > Manage Plugins**.
2. Go to the plugin settings/install section.
3. Choose **Install from file**.
4. Select the generated zip:

```text
geolibre-plugin/geolibre-netcdf-0.5.9.zip
```

You can also add the unpacked development directory:

```text
geolibre-plugin
```

## Usage

1. Activate **NetCDF Loader** from GeoLibre's Plugins menu if it is not already active.
2. Click the **NC** map control to open the plugin panel.
3. Choose a local NetCDF file or enter an HTTPS NetCDF URL.
4. Select a renderable variable, such as `tavg (time, lat, lon)`.
5. Set any non-spatial dimension indexes, such as `time index`.
6. Choose a colormap, opacity, and layer mode.
7. Click **Add raster layer**.
8. Use the layer's Identify button in GeoLibre's left Layers panel to inspect pixel values.

Use **GeoLibre layer (left panel)** when you want the layer in GeoLibre's Layers panel. Use **Direct raster overlay** only for quick visual debugging without a left-panel entry.

## Build From Source

```bash
npm install
npm run package:geolibre
```

The packaged GeoLibre plugin archive is written to:

```text
geolibre-plugin/geolibre-netcdf-0.5.9.zip
```

## Development

Run tests:

```bash
npm test
```

Run a production build without packaging:

```bash
npm run build
```

The test suite includes a few pure grid helper checks. If a local sample file exists at `example_netcdf_files/JVBC_HistAnalog_tavg.nc`, the suite also runs a NetCDF4/HDF5 regression test against that file. The sample data directory is intentionally git-ignored to avoid committing large climate files.

## Limitations

- NetCDF4/HDF5 support depends on `h5wasm`; unsupported HDF5 features or compression filters may still fail.
- Classic NetCDF3/CDF files are detected but not rendered in version 1.
- Large multidimensional files are read in the browser/WebView, so very large arrays may be slow or memory-heavy.
- Curvilinear grids and projected coordinates are not fully supported yet; the current renderer expects latitude and longitude coordinates.
- Full GeoLibre Layers-panel integration requires a GeoLibre build that exposes `registerExternalNativeLayer`. Direct overlays render independently but are not visible in the left Layers panel.

## Repository Topics

Suggested GitHub topics:

```text
geolibre geolibre-plugin netcdf netcdf4 hdf5 climate-data gis maplibre raster colormap
```

## License

MIT License. See [LICENSE](LICENSE).
