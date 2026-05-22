# LiDAR data preparation tools

These Python helpers walk you through the last stages of turning raw
LiDAR data into the normalised Digital Surface Model (nDSM) GeoTIFF
that Helios's **BYO local nDSM** LiDAR provider consumes.

Contributed by [@jourdant](https://github.com/jourdant) in [PR #11](https://github.com/ReikanYsora/Helios/pull/11),
complementing his original [PR #5](https://github.com/ReikanYsora/Helios/pull/5)
that wired up the BYO LiDAR provider itself. The motivation: give the
same LiDAR-quality shadows to users outside the five countries Helios
has built-in providers for (France, UK, Spain, Netherlands, Norway),
without forcing them to learn the full geospatial toolchain from
scratch.

## Why these tools exist

Helios renders realistic ground shadows from buildings and vegetation
when LiDAR data is available for the home's location, AND uses the same
nDSM to ray-march each PV array against the surrounding terrain so the
forecast zeroes the direct-beam component on arrays the sun no longer
reaches (a tree to the west at 18 h, a tall neighbour to the south at
noon, a hill that drops the sun an hour early). The five built-in
providers fetch national open data directly. For everywhere else, the
BYO local nDSM provider lets users supply their own raster, as long as
it matches the format the pipeline expects: a Float32 GeoTIFF where
each pixel value is height above ground in metres (an nDSM = DSM minus
DTM, prepared offline).

The raw LiDAR you can download from government open-data portals
(typically `.las` / `.laz` point clouds, sometimes pre-rasterised DSM
and DTM tiles) is not in that format. Getting there requires:

1. (Optional, point clouds only) rasterise the point cloud into a DSM.
2. Subtract a bare-earth DTM from the DSM to get the nDSM.
3. Validate the result (CRS, bbox, resolution, no-data, height range).
4. Convert to a [Cloud Optimized GeoTIFF (COG)](https://www.cogeo.org/)
   so the browser can stream it by tile instead of pulling the full
   file at once.

These tools focus on steps 3 and 4 (inspect, convert), plus a synthetic
raster generator so you can smoke-test the BYO LiDAR config before
downloading any real data. Steps 1 and 2 are upstream and depend on
which provider you start from; see your provider's documentation or
look into [PDAL](https://pdal.io/) and `gdal_calc.py` directly.

## Prerequisites

The tools are Python 3.12 wrappers around GDAL and numpy. You need
three things installed before running them.

### 1. GDAL system library

The Python `gdal` package is a binding around the GDAL C/C++ library,
which has to be installed at the OS level FIRST:

- **macOS**: `brew install gdal`
- **Debian / Ubuntu**: `sudo apt install gdal-bin libgdal-dev`
- **Arch**: `sudo pacman -S gdal`
- **Windows**: easiest path is via Conda, `conda install -c conda-forge gdal`,
  and then run the rest from inside the Conda environment.

Sanity check: if `gdalinfo --version` works in your terminal, the
system library is in place.

### 2. Python 3.12

The toolchain is pinned to Python 3.12 (`.python-version` at the repo
root). Other 3.x versions may work but are not tested.

### 3. uv

Dependencies are managed with [`uv`](https://docs.astral.sh/uv/), the
modern Python package manager from Astral:

```bash
# macOS / Linux
curl -LsSf https://astral.sh/uv/install.sh | sh

# Windows (PowerShell)
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
```

Then from the `tools/` directory (where `pyproject.toml` lives):

```bash
cd tools
uv sync
```

This creates `tools/.venv/` and installs `numpy` + `gdal` (the Python
bindings). If `uv sync` fails on the `gdal` install, re-check step 1,
the Python bindings need a matching system library to compile against.

All `uv run` commands below assume you are running from `tools/`. If
you prefer to stay at the repo root, prefix them with
`--project tools`, e.g. `uv --project tools run python lidar/make_test_ndsm.py`.

## Workflow

The tools share a `data/<dataset>/raw|work|out/` convention so you can
keep multiple regions side by side without renaming files between
runs. `data/` itself is gitignored, so anything in there stays local:

```text
data/
  <region>/
    raw/      <- original sources (LAS / LAZ tiles, downloaded DSM/DTM)
    work/     <- intermediates (the nDSM after DSM-DTM subtraction)
    out/      <- final COG ready to host
```

If you do not pass `--dataset`, the tools default to `data/test/`.

### Generate a synthetic test raster

When you want to smoke-test the BYO LiDAR wiring (the 6
`lidar-local-ndsm-*` keys + the file path) without going through a
full prep pipeline first:

```bash
uv run python lidar/make_test_ndsm.py
```

Writes `data/test/work/helios-test-ndsm.tif`. The synthetic raster
contains four fake structures (8 m, 14 m, 10 m and 2 m tall) at known
positions inside a small bbox near Sydney. Override the bbox or write
into another dataset:

```bash
uv run python lidar/make_test_ndsm.py \
  --dataset demo \
  --filename demo-ndsm.tif \
  --min-lon 150.0 --max-lon 150.002 \
  --min-lat -34.002 --max-lat -34.0
```

### Inspect an nDSM

Prints the CRS, bbox corners, resolution, no-data sentinel and per-
band height range for a GeoTIFF. Always run this on any raster before
pointing Helios at it, the no-data field is especially important (see
Caveats):

```bash
uv run python lidar/inspect_ndsm.py --dataset <region> --filename <yourfile>.tif
```

Or with an explicit path:

```bash
uv run python lidar/inspect_ndsm.py /path/to/file.tif
```

### Convert a regular GeoTIFF to COG

Wraps `gdal_translate -of COG -co COMPRESS=DEFLATE -co BLOCKSIZE=256`.
COG layout lets the browser stream the raster by 256 px tiles instead
of pulling the full file at once:

```bash
uv run python lidar/convert_ndsm_to_cog.py --dataset <region>
```

Default input is `data/<region>/work/helios-test-ndsm.tif` (override
with `--input-filename`); default output goes to
`data/<region>/out/helios-test-ndsm-cog.tif` (override with
`--output-filename`).

## Hosting the result for Helios

Once you have a COG ready, copy it under a path Home Assistant can
serve. The conventional location is:

```text
/config/www/community/Helios/lidar/<region>-ndsm.tif
```

Which is reachable from the browser at:

```text
/local/community/Helios/lidar/<region>-ndsm.tif
```

Then set the BYO LiDAR keys in the card YAML (or via the editor):

```yaml
type: custom:helios-card
lidar-local-ndsm-enabled: true
lidar-local-ndsm-url: /local/community/Helios/lidar/<region>-ndsm.tif
lidar-local-ndsm-min-lat: <bottom edge of the raster, EPSG:4326>
lidar-local-ndsm-max-lat: <top edge>
lidar-local-ndsm-min-lon: <left edge>
lidar-local-ndsm-max-lon: <right edge>
```

`inspect_ndsm.py` prints the corner coordinates so you can paste them
straight into the bbox fields.

## Caveats

### No-data semantics

The shipped test raster (`make_test_ndsm.py`) sets the GeoTIFF's
`nodata` tag to `0`. That works for the synthetic case because ground
cells are then interpreted as "no contribution", leaving only the four
fake structures visible. **For real nDSM files this is the wrong
convention**: ground is a valid 0 value, you do NOT want it dropped.
If you start from raw data, pick a sentinel like `-9999` and make sure
`gdal_translate` sets `nodata=-9999` on the COG. Verify with
`inspect_ndsm.py` before going live.

### Helios's in-browser normalisation

Once the COG arrives in the browser, the BYO provider runs the same
normalisation as every other Helios LiDAR source:

- cells matching the `nodata` tag → `NaN`
- non-finite values → `NaN`
- finite negatives clamp to `0`
- finite non-negatives pass through unchanged

So make sure the `nodata` tag is correct upstream, the in-browser
normalisation cannot recover the right semantics if it's set wrong.

### `data/` stays local

`data/**` is gitignored (only `data/README.md` is committed, to keep
the directory structure visible). Treat it as scratch space, none of
your inputs or outputs will be pushed by accident.

---

For the upstream point cloud → DSM / DTM stage, look at
[PDAL](https://pdal.io/) tutorials or your provider's own
documentation. Helios's pipeline starts from a ready-made nDSM,
intentionally, to keep the scope of these helpers narrow and
predictable.
