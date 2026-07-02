# GeoLibre NetCDF Loader Plugin

GeoLibre NetCDF Loader Plugin adds NetCDF4/HDF5 climate-grid support to GeoLibre Desktop. It reads local or HTTPS NetCDF4 files, lets you choose a variable and 2D slice, and renders the result as a native raster layer when GeoLibre's raster API is available.

Developed by **Husayn El Sharif**.

## Features

- Load local `.nc`, `.cdf`, and `.netcdf` files.
- Load HTTPS NetCDF files with the `?netcdfUrl=...` URL parameter.
- Detect classic NetCDF3/CDF files and explain that they are not supported in version 1.
- Read NetCDF4/HDF5 files with `h5wasm`.
- Detect common latitude and longitude coordinate variables.
- Select non-spatial dimension indexes such as `time`, `level`, or `depth`.
- Render selected slices as true MapLibre canvas raster overlays by default.
- Keep GeoLibre's native `addCogLayer` path as a compatibility route when direct map access is unavailable.
- Render with Panoply-inspired color ramps:
  - Temperature
  - Viridis
  - Turbo
  - Blue-red
  - Grayscale
- Use plugin-managed MapLibre raster overlays by default, with GeoLibre's native layer path available as a compatibility route.

## Rendering Approach

The default path renders the selected NetCDF slice into an in-memory canvas and registers it directly with MapLibre as a `canvas` source and `raster` layer. This avoids GeoLibre builds where `addCogLayer` registers a COG layer in the Layers panel but does not draw local in-memory rasters.

When direct map access is unavailable, the plugin can still attempt GeoLibre's native `addCogLayer` path using an in-memory GeoTIFF. The direct canvas path is still raster rendering, not a vector fallback. Because it bypasses GeoLibre's layer store, direct overlays are managed from the plugin panel rather than the left Layers panel.

## Install

Download or build the plugin zip, then install it in GeoLibre Desktop:

1. Open **Settings > Manage Plugins**.
2. Go to the plugin settings/install section.
3. Choose **Install from file**.
4. Select the generated zip:

```text
geolibre-plugin/geolibre-netcdf-0.4.2.zip
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
6. Choose a colormap and opacity.
7. Click **Add raster layer**.

The raster should appear on the map as a plugin-managed MapLibre overlay and can be removed from the NetCDF panel.

## Build From Source

```bash
npm install
npm run package:geolibre
```

The packaged GeoLibre plugin archive is written to:

```text
geolibre-plugin/geolibre-netcdf-0.4.2.zip
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
- Full GeoLibre Layers-panel integration depends on GeoLibre's `addCogLayer` behavior for local in-memory rasters. The default renderer uses plugin-managed MapLibre raster overlays because that path has proven more reliable in current GeoLibre Desktop builds.

## Repository Topics

Suggested GitHub topics:

```text
geolibre geolibre-plugin netcdf netcdf4 hdf5 climate-data gis maplibre raster colormap
```

## License

MIT License. See [LICENSE](LICENSE).
