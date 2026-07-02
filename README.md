# GeoLibre NetCDF Loader Plugin

GeoLibre NetCDF Loader Plugin adds NetCDF climate-grid support to GeoLibre Desktop. It reads local or HTTPS NetCDF files, lets you choose a variable and 2D slice, and renders the result as a color-mapped raster-style map layer.

Developed by **Husayn El Sharif**.

## Features

- Load local `.nc`, `.cdf`, and `.netcdf` files.
- Load HTTPS NetCDF files with the `?netcdfUrl=...` URL parameter.
- Read classic NetCDF v3 files with `netcdfjs`.
- Read many NetCDF4/HDF5 files with `jsfive`.
- Detect common latitude and longitude coordinate variables.
- Select non-spatial dimension indexes such as `time`, `level`, or `depth`.
- Render selected slices with Panoply-inspired color ramps:
  - Temperature
  - Viridis
  - Turbo
  - Blue-red
  - Grayscale
- Register output through GeoLibre's native layer path so it appears in the Layers panel.

## Current Rendering Approach

GeoLibre external plugins can reliably register vector data through `addGeoJsonLayer`. For maximum compatibility with GeoLibre Desktop, this plugin currently converts the selected 2D NetCDF grid into colored cell polygons. Visually this behaves like a raster grid, while remaining visible and manageable in GeoLibre's native Layers panel.

Future versions may add true client-side raster output through COG, tiled image, or deck.gl rendering paths as GeoLibre's plugin raster APIs mature.

## Install

Download or build the plugin zip, then install it in GeoLibre Desktop:

1. Open **Settings > Manage Plugins**.
2. Go to the plugin settings/install section.
3. Choose **Install from file**.
4. Select the generated zip:

```text
geolibre-plugin/geolibre-netcdf-0.2.1.zip
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
geolibre-plugin/geolibre-netcdf-0.2.1.zip
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
- The raster-style layer is currently represented as colored GeoJSON cell polygons for GeoLibre layer-store compatibility.

## Repository Topics

Suggested GitHub topics:

```text
geolibre geolibre-plugin netcdf netcdf4 hdf5 climate-data gis maplibre raster colormap
```

## License

MIT License. See [LICENSE](LICENSE).
