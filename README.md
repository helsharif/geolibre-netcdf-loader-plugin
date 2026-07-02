# GeoLibre NetCDF Loader Plugin

GeoLibre NetCDF Loader Plugin adds NetCDF climate-grid support to GeoLibre Desktop. It reads local or HTTPS NetCDF files, lets you choose a variable and 2D slice, and renders the result as a native raster layer when GeoLibre's raster API is available.

Developed by **Husayn El Sharif**.

## Features

- Load local `.nc`, `.cdf`, and `.netcdf` files.
- Load HTTPS NetCDF files with the `?netcdfUrl=...` URL parameter.
- Read classic NetCDF v3 files with `netcdfjs`.
- Read many NetCDF4/HDF5 files with `jsfive`.
- Detect common latitude and longitude coordinate variables.
- Select non-spatial dimension indexes such as `time`, `level`, or `depth`.
- Render selected slices as temporary GeoTIFF/COG-style raster layers through GeoLibre's native `addCogLayer` API.
- Fall back to colored cell polygons on older GeoLibre builds that do not expose `addCogLayer`.
- Render with Panoply-inspired color ramps:
  - Temperature
  - Viridis
  - Turbo
  - Blue-red
  - Grayscale
- Register output through GeoLibre's native layer path so it appears in the Layers panel.

## Rendering Approach

The preferred path converts the selected NetCDF slice into an in-memory, georeferenced single-band GeoTIFF and registers it through GeoLibre's native `addCogLayer` helper. This produces an actual raster layer in GeoLibre, with raster styling and layer-store integration.

For compatibility, the plugin keeps a fallback path that converts the same grid into colored GeoJSON cell polygons. That fallback is less ideal because GeoLibre treats it as a vector layer, but it is useful on older builds or host variants without native raster helpers.

## Install

Download or build the plugin zip, then install it in GeoLibre Desktop:

1. Open **Settings > Manage Plugins**.
2. Go to the plugin settings/install section.
3. Choose **Install from file**.
4. Select the generated zip:

```text
geolibre-plugin/geolibre-netcdf-0.3.0.zip
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

The layer should appear in GeoLibre's Layers panel and on the map.

## Build From Source

```bash
npm install
npm run package:geolibre
```

The packaged GeoLibre plugin archive is written to:

```text
geolibre-plugin/geolibre-netcdf-0.3.0.zip
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

- NetCDF4/HDF5 support depends on `jsfive`, which does not implement every HDF5 feature or datatype.
- Large multidimensional files are read in the browser/WebView, so very large arrays may be slow or memory-heavy.
- Curvilinear grids and projected coordinates are not fully supported yet; the current renderer expects latitude and longitude coordinates.
- Native raster rendering requires a GeoLibre build that exposes `addCogLayer`; otherwise the plugin falls back to colored GeoJSON cell polygons.

## Repository Topics

Suggested GitHub topics:

```text
geolibre geolibre-plugin netcdf netcdf4 hdf5 climate-data gis maplibre raster colormap
```

## License

MIT License. See [LICENSE](LICENSE).
