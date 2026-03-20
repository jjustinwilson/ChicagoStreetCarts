/* ===================================================================
   Chicago Sidewalk Exclusion Zone Map
   ===================================================================
   Tile-based rendering with PMTiles:
     - Sidewalk polygons stored in a static .pmtiles file (vector tiles)
     - Only tiles in the current viewport are fetched via HTTP range requests
     - Decoded MVT polygons drawn to a cache canvas in green
     - Display canvas copies the cache then punches out buffer circles
       via globalCompositeOperation = 'destination-out'

   Stats use pixel-counting inside a user-drawn study-area polygon.
   =================================================================== */

(function () {
  "use strict";

  /* ----------------------------------------------------------------
     Constants
     ---------------------------------------------------------------- */
  var CHICAGO = [41.8827, -87.6233];   // The Loop
  var INITIAL_ZOOM = 14;
  var SW_FILL = "#4caf50";
  var SW_ALPHA = 0.65;
  var FT_PER_M = 3.28084;
  var DEG_TO_RAD = Math.PI / 180;
  var TILE_MIN_ZOOM = 14;
  var TILE_MAX_ZOOM = 16;
  var TILE_CACHE_LIMIT = 200;
  var IS_MOBILE = navigator.maxTouchPoints > 0;

  /* ----------------------------------------------------------------
     Map
     ---------------------------------------------------------------- */
  var map = L.map("map", {
    center: CHICAGO,
    zoom: INITIAL_ZOOM,
    minZoom: 14,
    zoomControl: false,
    preferCanvas: true,
  });
  L.control.zoom({ position: "bottomright" }).addTo(map);

  L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
    {
      attribution:
        '&copy; <a href="https://carto.com/">CARTO</a> &copy; ' +
        '<a href="https://openstreetmap.org/copyright">OSM</a>',
      subdomains: "abcd",
      maxZoom: 19,
    }
  ).addTo(map);

  /* ----------------------------------------------------------------
     State
     ---------------------------------------------------------------- */
  var restaurantCoords = [];
  var bufferFeet = 0;
  var studyLayer = null;
  var showRestaurants = true;
  var restaurantPointLayer = null;
  var restaurantBufferLayer = null;
  var tileSource = null;        // PMTiles instance
  var tileCache = {};           // "z/x/y" -> { features, extent }
  var pendingTiles = {};        // "z/x/y" -> Promise
  var dataReady = false;

  /* ----------------------------------------------------------------
     Tile coordinate helpers
     ---------------------------------------------------------------- */
  function lng2tile(lng, z) {
    return Math.floor((lng + 180) / 360 * (1 << z));
  }

  function lat2tile(lat, z) {
    var rad = lat * DEG_TO_RAD;
    return Math.floor(
      (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * (1 << z)
    );
  }

  function tile2lng(x, z) {
    return x / (1 << z) * 360 - 180;
  }

  function tile2lat(y, z) {
    var n = Math.PI - 2 * Math.PI * y / (1 << z);
    return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  }

  function tileZoom() {
    var z = Math.round(map.getZoom());
    return Math.max(TILE_MIN_ZOOM, Math.min(TILE_MAX_ZOOM, z));
  }

  function getVisibleTileCoords(z) {
    var b = map.getBounds().pad(0.15);
    var minX = lng2tile(b.getWest(), z);
    var maxX = lng2tile(b.getEast(), z);
    var minY = lat2tile(b.getNorth(), z);
    var maxY = lat2tile(b.getSouth(), z);
    var maxTile = (1 << z) - 1;
    minX = Math.max(0, minX);
    maxX = Math.min(maxTile, maxX);
    minY = Math.max(0, minY);
    maxY = Math.min(maxTile, maxY);
    var coords = [];
    for (var x = minX; x <= maxX; x++) {
      for (var y = minY; y <= maxY; y++) {
        coords.push({ z: z, x: x, y: y });
      }
    }
    return coords;
  }

  /* ----------------------------------------------------------------
     Tile decode worker
     ---------------------------------------------------------------- */
  var tileWorker = new Worker("js/tile-worker.js");
  var workerCallbacks = {};
  var workerIdCounter = 0;

  tileWorker.onmessage = function (e) {
    var id = e.data.id;
    var cb = workerCallbacks[id];
    if (cb) {
      delete workerCallbacks[id];
      cb(e.data.layer);
    }
  };

  function decodeInWorker(buffer) {
    return new Promise(function (resolve) {
      var id = ++workerIdCounter;
      workerCallbacks[id] = resolve;
      tileWorker.postMessage({ id: id, buffer: buffer }, [buffer]);
    });
  }

  /* ----------------------------------------------------------------
     Tile cache eviction
     ---------------------------------------------------------------- */
  var tileCacheKeys = [];   // insertion-order tracking

  function evictTileCache() {
    if (tileCacheKeys.length <= TILE_CACHE_LIMIT) return;
    var evictCount = Math.floor(tileCacheKeys.length / 2);
    var removed = tileCacheKeys.splice(0, evictCount);
    for (var i = 0; i < removed.length; i++) {
      delete tileCache[removed[i]];
    }
  }

  /* ----------------------------------------------------------------
     Fetch + decode a single tile (with cache + worker)
     ---------------------------------------------------------------- */
  function fetchTile(z, x, y) {
    var key = z + "/" + x + "/" + y;
    if (tileCache.hasOwnProperty(key)) return Promise.resolve(tileCache[key]);
    if (pendingTiles[key]) return pendingTiles[key];

    var p = tileSource.getZxy(z, x, y).then(function (resp) {
      delete pendingTiles[key];
      if (!resp || !resp.data) {
        tileCache[key] = null;
        tileCacheKeys.push(key);
        evictTileCache();
        return null;
      }
      return decodeInWorker(resp.data).then(function (layer) {
        tileCache[key] = layer;
        tileCacheKeys.push(key);
        evictTileCache();
        return layer;
      });
    }).catch(function () {
      delete pendingTiles[key];
      tileCache[key] = null;
      tileCacheKeys.push(key);
      evictTileCache();
      return null;
    });

    pendingTiles[key] = p;
    return p;
  }

  /* ----------------------------------------------------------------
     Custom Leaflet pane + canvases
     ---------------------------------------------------------------- */
  map.createPane("sidewalkPane");
  var sidewalkPane = map.getPane("sidewalkPane");
  sidewalkPane.style.zIndex = 250;
  sidewalkPane.style.pointerEvents = "none";

  var cacheCanvas = document.createElement("canvas");
  var cacheCtx = cacheCanvas.getContext("2d");
  var displayCanvas = document.createElement("canvas");
  var displayCtx = displayCanvas.getContext("2d");
  sidewalkPane.appendChild(displayCanvas);

  var redrawTimer = null;
  function scheduleRedraw() {
    if (redrawTimer) clearTimeout(redrawTimer);
    redrawTimer = setTimeout(function () {
      redrawTimer = null;
      redrawCache();
    }, IS_MOBILE ? 200 : 120);
  }

  map.on("moveend",   scheduleRedraw);
  map.on("zoomend",   scheduleRedraw);
  map.on("viewreset", scheduleRedraw);
  map.on("resize",    scheduleRedraw);

  /* ----------------------------------------------------------------
     Geometry helpers
     ---------------------------------------------------------------- */

  function feetToPixelRadius(feet) {
    var meters = feet / FT_PER_M;
    var center = map.getCenter();
    var lat = center.lat;
    var lng = center.lng;
    var dLng = meters / (111320 * Math.cos(lat * DEG_TO_RAD));
    var p1 = map.latLngToContainerPoint([lat, lng]);
    var p2 = map.latLngToContainerPoint([lat, lng + dLng]);
    return Math.abs(p2.x - p1.x);
  }

  /* ----------------------------------------------------------------
     Canvas drawing  — tile-based
     ---------------------------------------------------------------- */

  function resizeCanvases() {
    var s = map.getSize();
    cacheCanvas.width = s.x;
    cacheCanvas.height = s.y;
    displayCanvas.width = s.x;
    displayCanvas.height = s.y;
  }

  function drawTileToCache(layer, z, x, y) {
    if (!layer || !layer.features.length) return;
    var ext = layer.extent;

    var nwLat = tile2lat(y, z);
    var nwLng = tile2lng(x, z);
    var seLat = tile2lat(y + 1, z);
    var seLng = tile2lng(x + 1, z);

    var nwPt = map.latLngToContainerPoint([nwLat, nwLng]);
    var sePt = map.latLngToContainerPoint([seLat, seLng]);

    var tLeft = nwPt.x;
    var tTop = nwPt.y;
    var tW = sePt.x - nwPt.x;
    var tH = sePt.y - nwPt.y;
    var sx = tW / ext;
    var sy = tH / ext;

    var features = layer.features;
    for (var f = 0; f < features.length; f++) {
      var rings = features[f];
      for (var r = 0; r < rings.length; r++) {
        var ring = rings[r];
        for (var v = 0; v < ring.length; v++) {
          var px = tLeft + ring[v][0] * sx;
          var py = tTop + ring[v][1] * sy;
          if (v === 0) cacheCtx.moveTo(px, py);
          else cacheCtx.lineTo(px, py);
        }
        cacheCtx.closePath();
      }
    }
  }

  function redrawCache() {
    if (!dataReady) return;
    resizeCanvases();

    displayCanvas.style.transform = "";
    var origin = map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(displayCanvas, origin);

    var w = cacheCanvas.width, h = cacheCanvas.height;
    cacheCtx.clearRect(0, 0, w, h);

    var z = tileZoom();
    var coords = getVisibleTileCoords(z);

    var cached = [];
    var toFetch = [];

    for (var i = 0; i < coords.length; i++) {
      var key = coords[i].z + "/" + coords[i].x + "/" + coords[i].y;
      if (tileCache.hasOwnProperty(key)) {
        cached.push(coords[i]);
      } else {
        toFetch.push(coords[i]);
      }
    }

    var zoom = map.getZoom();

    cacheCtx.fillStyle = SW_FILL;
    cacheCtx.globalAlpha = SW_ALPHA;
    cacheCtx.beginPath();

    for (var i = 0; i < cached.length; i++) {
      var c = cached[i];
      var layer = tileCache[c.z + "/" + c.x + "/" + c.y];
      if (layer) drawTileToCache(layer, c.z, c.x, c.y);
    }

    cacheCtx.fill("evenodd");

    if (zoom < 17) {
      cacheCtx.strokeStyle = SW_FILL;
      cacheCtx.lineWidth = zoom < 14 ? 2 : zoom < 16 ? 1.5 : 1;
      cacheCtx.stroke();
    }

    cacheCtx.globalAlpha = 1.0;
    compositeDisplay();

    if (toFetch.length) {
      var promises = toFetch.map(function (c) {
        return fetchTile(c.z, c.x, c.y);
      });
      Promise.all(promises).then(function () {
        redrawCacheSync();
      });
    }
  }

  function redrawCacheSync() {
    resizeCanvases();

    displayCanvas.style.transform = "";
    var origin = map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(displayCanvas, origin);

    var w = cacheCanvas.width, h = cacheCanvas.height;
    cacheCtx.clearRect(0, 0, w, h);

    var z = tileZoom();
    var coords = getVisibleTileCoords(z);
    var zoom = map.getZoom();

    cacheCtx.fillStyle = SW_FILL;
    cacheCtx.globalAlpha = SW_ALPHA;
    cacheCtx.beginPath();

    for (var i = 0; i < coords.length; i++) {
      var c = coords[i];
      var layer = tileCache[c.z + "/" + c.x + "/" + c.y];
      if (layer) drawTileToCache(layer, c.z, c.x, c.y);
    }

    cacheCtx.fill("evenodd");

    if (zoom < 17) {
      cacheCtx.strokeStyle = SW_FILL;
      cacheCtx.lineWidth = zoom < 14 ? 2 : zoom < 16 ? 1.5 : 1;
      cacheCtx.stroke();
    }

    cacheCtx.globalAlpha = 1.0;
    compositeDisplay();
  }

  function compositeDisplay() {
    var w = displayCanvas.width,
      h = displayCanvas.height;
    displayCtx.clearRect(0, 0, w, h);
    displayCtx.drawImage(cacheCanvas, 0, 0);

    if (bufferFeet <= 0 || !restaurantCoords.length) {
      computeStats();
      return;
    }

    var radiusPx = feetToPixelRadius(bufferFeet);
    if (radiusPx < 0.5) {
      computeStats();
      return;
    }

    displayCtx.globalCompositeOperation = "destination-out";
    displayCtx.fillStyle = "rgba(0,0,0,1)";
    displayCtx.beginPath();

    var vb = map.getBounds().pad(0.3);
    for (var i = 0; i < restaurantCoords.length; i++) {
      var ll = restaurantCoords[i];
      if (!vb.contains(ll)) continue;
      var pt = map.latLngToContainerPoint(ll);
      displayCtx.moveTo(pt.x + radiusPx, pt.y);
      displayCtx.arc(pt.x, pt.y, radiusPx, 0, Math.PI * 2);
    }
    displayCtx.fill();
    displayCtx.globalCompositeOperation = "source-over";

    computeStats();
  }

  /* ----------------------------------------------------------------
     Data loading
     ---------------------------------------------------------------- */

  var loadBar = document.getElementById("loading-bar-fill");
  var loadDetail = document.getElementById("loading-detail");

  function setLoadProgress(pct, msg) {
    if (loadBar) loadBar.style.width = pct + "%";
    if (loadDetail) loadDetail.textContent = msg || "";
  }

  function loadData() {
    setLoadProgress(0, "Initialising tile source\u2026");

    tileSource = new pmtiles.PMTiles("data/sidewalks.pmtiles");

    setLoadProgress(10, "Downloading restaurant data\u2026");

    var restaurantsDone = fetch("data/restaurants.json")
      .then(function (r) { return r.json(); })
      .then(function (gj) {
        setLoadProgress(30, "Processing restaurants\u2026");
        for (var i = 0; i < gj.features.length; i++) {
          var geom = gj.features[i].geometry;
          if (!geom || !geom.coordinates) continue;
          var c = geom.coordinates;
          restaurantCoords.push(L.latLng(c[1], c[0]));
        }
        setLoadProgress(40, "Restaurants ready (" + restaurantCoords.length + ")");
      });

    restaurantsDone.then(function () {
      setLoadProgress(85, "Ready");
      dataReady = true;
      setTimeout(function () {
        redrawCache();
        if (showRestaurants) updateRestaurantLayers();
        setLoadProgress(100, "Done");
        hideLoading();
      }, 20);
    });
  }

  function hideLoading() {
    var el = document.getElementById("loading");
    if (!el) return;
    el.classList.add("fade-out");
    setTimeout(function () { el.parentNode.removeChild(el); }, 350);
  }

  /* ----------------------------------------------------------------
     Slider
     ---------------------------------------------------------------- */
  var slider = document.getElementById("buffer-slider");
  var sliderLabel = document.getElementById("slider-value");

  slider.addEventListener("input", function () {
    bufferFeet = parseInt(this.value, 10);
    sliderLabel.textContent = bufferFeet;
    compositeDisplay();
    if (showRestaurants) rebuildBufferCircles();
  });

  /* ----------------------------------------------------------------
     Neighborhood zoom
     ---------------------------------------------------------------- */
  var neighborhoodSelect = document.getElementById("neighborhood-select");
  neighborhoodSelect.addEventListener("change", function () {
    if (!this.value) return;
    var p = this.value.split(",");
    map.flyTo([parseFloat(p[0]), parseFloat(p[1])], parseInt(p[2], 10));
    this.value = "";
  });

  /* ----------------------------------------------------------------
     Drawing tools
     ---------------------------------------------------------------- */
  var drawnItems = new L.FeatureGroup().addTo(map);

  var drawOpts = {
    shapeOptions: {
      color: "#1976d2",
      weight: 2,
      fillOpacity: 0.08,
      dashArray: "6 4",
    },
  };
  var drawRect = new L.Draw.Rectangle(map, drawOpts);
  var drawPoly = new L.Draw.Polygon(
    map,
    Object.assign({}, drawOpts, {
      allowIntersection: false,
      showArea: false,
    })
  );

  var btnRect = document.getElementById("btn-rect");
  var btnPoly = document.getElementById("btn-poly");
  var btnClear = document.getElementById("btn-clear");
  var activeDrawer = null;

  btnRect.addEventListener("click", function () {
    stopDrawing();
    activeDrawer = drawRect;
    drawRect.enable();
    btnRect.classList.add("active");
  });

  btnPoly.addEventListener("click", function () {
    stopDrawing();
    activeDrawer = drawPoly;
    drawPoly.enable();
    btnPoly.classList.add("active");
  });

  btnClear.addEventListener("click", clearStudyArea);

  function stopDrawing() {
    if (activeDrawer) activeDrawer.disable();
    activeDrawer = null;
    btnRect.classList.remove("active");
    btnPoly.classList.remove("active");
  }

  function clearStudyArea() {
    stopDrawing();
    drawnItems.clearLayers();
    studyLayer = null;
    btnClear.disabled = true;
    document.getElementById("stats-body").classList.add("hidden");
  }

  map.on(L.Draw.Event.CREATED, function (e) {
    stopDrawing();
    drawnItems.clearLayers();
    studyLayer = e.layer;
    drawnItems.addLayer(studyLayer);
    btnClear.disabled = false;
    document.getElementById("stats-body").classList.remove("hidden");
    computeStats();
  });

  /* ----------------------------------------------------------------
     Stats — pixel counting inside the drawn study area
     ---------------------------------------------------------------- */

  function getStudyScreenPoly() {
    if (!studyLayer) return null;
    var latlngs = studyLayer.getLatLngs();
    var ring = latlngs[0] || latlngs;
    var pts = [];
    for (var i = 0; i < ring.length; i++) {
      pts.push(map.latLngToContainerPoint(ring[i]));
    }
    return pts;
  }

  function pointInPoly(x, y, poly) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var xi = poly[i].x,
        yi = poly[i].y;
      var xj = poly[j].x,
        yj = poly[j].y;
      if (
        yi > y !== yj > y &&
        x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
      ) {
        inside = !inside;
      }
    }
    return inside;
  }

  function computeStats() {
    if (!studyLayer) return;

    var poly = getStudyScreenPoly();
    if (!poly || poly.length < 3) return;

    var minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (var i = 0; i < poly.length; i++) {
      if (poly[i].x < minX) minX = poly[i].x;
      if (poly[i].y < minY) minY = poly[i].y;
      if (poly[i].x > maxX) maxX = poly[i].x;
      if (poly[i].y > maxY) maxY = poly[i].y;
    }
    minX = Math.max(0, Math.floor(minX));
    minY = Math.max(0, Math.floor(minY));
    maxX = Math.min(displayCanvas.width, Math.ceil(maxX));
    maxY = Math.min(displayCanvas.height, Math.ceil(maxY));

    var w = maxX - minX;
    var h = maxY - minY;
    if (w <= 0 || h <= 0) return;

    var area = w * h;
    var step;
    if (IS_MOBILE) {
      step = area > 500000 ? 5 : area > 100000 ? 4 : 3;
    } else {
      step = area > 500000 ? 3 : area > 100000 ? 2 : 1;
    }

    var cacheData = cacheCtx.getImageData(minX, minY, w, h).data;
    var dispData = displayCtx.getImageData(minX, minY, w, h).data;

    var totalPx = 0;
    var remainPx = 0;

    for (var py = 0; py < h; py += step) {
      for (var px = 0; px < w; px += step) {
        if (!pointInPoly(minX + px, minY + py, poly)) continue;
        var off = (py * w + px) * 4;
        if (cacheData[off + 3] > 30) {
          totalPx++;
          if (dispData[off + 3] > 30) remainPx++;
        }
      }
    }

    var pctLost = totalPx > 0 ? (1 - remainPx / totalPx) * 100 : 0;
    document.getElementById("stat-pct").textContent =
      pctLost.toFixed(1) + "%";
    document.getElementById("stat-bar-remaining").style.width =
      (100 - pctLost).toFixed(1) + "%";
    document.getElementById("stat-bar-lost").style.width =
      pctLost.toFixed(1) + "%";
  }

  /* ----------------------------------------------------------------
     Restaurant visibility toggle
     ---------------------------------------------------------------- */
  var showRestaurantsCheckbox = document.getElementById("show-restaurants");

  showRestaurantsCheckbox.addEventListener("change", function () {
    showRestaurants = this.checked;
    updateRestaurantLayers();
  });

  function updateRestaurantLayers() {
    if (showRestaurants && restaurantCoords.length) {
      if (!restaurantPointLayer) {
        restaurantPointLayer = L.layerGroup();
        restaurantBufferLayer = L.layerGroup();

        for (var i = 0; i < restaurantCoords.length; i++) {
          var ll = restaurantCoords[i];
          L.circleMarker(ll, {
            radius: 3,
            fillColor: "#e65100",
            color: "#bf360c",
            weight: 0.5,
            fillOpacity: 0.8,
          }).addTo(restaurantPointLayer);
        }
      }
      rebuildBufferCircles();
      restaurantBufferLayer.addTo(map);
      restaurantPointLayer.addTo(map);
    } else {
      if (restaurantPointLayer) map.removeLayer(restaurantPointLayer);
      if (restaurantBufferLayer) map.removeLayer(restaurantBufferLayer);
    }
  }

  function rebuildBufferCircles() {
    if (!restaurantBufferLayer) return;
    restaurantBufferLayer.clearLayers();
    if (bufferFeet <= 0) return;

    var meters = bufferFeet / FT_PER_M;
    for (var i = 0; i < restaurantCoords.length; i++) {
      L.circle(restaurantCoords[i], {
        radius: meters,
        color: "#e65100",
        weight: 1,
        fillColor: "#e65100",
        fillOpacity: 0.10,
        dashArray: "4 3",
      }).addTo(restaurantBufferLayer);
    }
  }

  /* ----------------------------------------------------------------
     Init
     ---------------------------------------------------------------- */
  loadData();
})();
