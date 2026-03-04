#!/usr/bin/env python3
"""
Pre-process Chicago sidewalks and restaurant shapefiles for web display.

Reads raw shapefiles in NAD83 StatePlane Illinois East (US feet),
reprojects to WGS84, simplifies sidewalk geometry, and exports
web-ready TopoJSON (sidewalks) and GeoJSON (restaurants).
"""

import json
import sys
from pathlib import Path

import geopandas as gpd
import topojson as tp

ROOT = Path(__file__).resolve().parent.parent
DATA_OUT = ROOT / "data"
DATA_OUT.mkdir(exist_ok=True)

SIDEWALKS_SHP = ROOT / "chicagosidewalks.shp"
RESTAURANTS_SHP = ROOT / "chicago_restaurants.shp"

# NAD83 StatePlane Illinois East (US survey feet)
SRC_CRS = "EPSG:3435"
DST_CRS = "EPSG:4326"

# Simplification tolerance in the *source* CRS (US feet).
# 5 feet preserves sidewalk shapes accurately while still
# reducing vertex count for web delivery.
SIMPLIFY_TOLERANCE_FT = 5

# Drop sidewalk polygons smaller than this (sq ft in source CRS).
MIN_AREA_SQFT = 50


def process_sidewalks() -> None:
    print(f"Reading {SIDEWALKS_SHP} …")
    gdf = gpd.read_file(SIDEWALKS_SHP)
    print(f"  {len(gdf)} features, CRS={gdf.crs}")

    if gdf.crs is None:
        gdf = gdf.set_crs(SRC_CRS)

    # Simplify in the projected CRS (feet) before reprojecting
    print(f"  Simplifying (tolerance={SIMPLIFY_TOLERANCE_FT} ft) …")
    gdf["geometry"] = gdf.geometry.simplify(
        tolerance=SIMPLIFY_TOLERANCE_FT, preserve_topology=True
    )

    # Drop tiny slivers
    areas = gdf.geometry.area
    before = len(gdf)
    gdf = gdf[areas >= MIN_AREA_SQFT].copy()
    print(f"  Dropped {before - len(gdf)} polygons < {MIN_AREA_SQFT} sq ft")

    # Drop all attribute columns — only geometry needed
    gdf = gdf[["geometry"]]

    # Remove any null / empty geometries
    gdf = gdf[~gdf.is_empty & gdf.is_valid].copy()

    # Reproject to WGS 84
    print("  Reprojecting to WGS 84 …")
    gdf = gdf.to_crs(DST_CRS)

    # Convert to TopoJSON via the topojson library
    print("  Converting to TopoJSON …")
    topo = tp.Topology(gdf, prequantize=1e6)
    out_path = DATA_OUT / "sidewalks.json"
    with open(out_path, "w") as f:
        f.write(topo.to_json())

    size_mb = out_path.stat().st_size / (1024 * 1024)
    print(f"  Written {out_path}  ({size_mb:.1f} MB)")


def process_restaurants() -> None:
    print(f"\nReading {RESTAURANTS_SHP} …")
    # .dbf is missing — fiona/geopandas may still read geometry
    try:
        gdf = gpd.read_file(RESTAURANTS_SHP)
    except Exception:
        # Fallback: read with fiona ignoring missing dbf
        import fiona
        with fiona.open(str(RESTAURANTS_SHP), ignore_geometry=False) as src:
            features = []
            for feat in src:
                features.append({
                    "type": "Feature",
                    "geometry": feat["geometry"],
                    "properties": {},
                })
        gdf = gpd.GeoDataFrame.from_features(features, crs=SRC_CRS)

    print(f"  {len(gdf)} features, CRS={gdf.crs}")

    if gdf.crs is None:
        gdf = gdf.set_crs(SRC_CRS)

    gdf = gdf[["geometry"]]
    gdf = gdf[gdf.geometry.notna() & ~gdf.is_empty].copy()

    print("  Reprojecting to WGS 84 …")
    gdf = gdf.to_crs(DST_CRS)

    out_path = DATA_OUT / "restaurants.json"
    gdf.to_file(out_path, driver="GeoJSON")

    size_kb = out_path.stat().st_size / 1024
    print(f"  Written {out_path}  ({size_kb:.0f} KB)")


def main() -> None:
    process_sidewalks()
    process_restaurants()
    print("\nDone.")


if __name__ == "__main__":
    main()
