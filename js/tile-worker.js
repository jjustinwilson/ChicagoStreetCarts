/* Web Worker for MVT tile decoding — keeps protobuf parsing off the main thread */

function decodeMVT(buf) {
  var pbf = new Uint8Array(buf);
  var pos = 0;

  function readVarint() {
    var result = 0, shift = 0, b;
    do {
      b = pbf[pos++];
      result |= (b & 0x7f) << shift;
      shift += 7;
    } while (b >= 0x80);
    return result >>> 0;
  }

  function skip(wireType) {
    if (wireType === 0) readVarint();
    else if (wireType === 1) pos += 8;
    else if (wireType === 2) { var n = readVarint(); pos += n; }
    else if (wireType === 5) pos += 4;
  }

  function readString(len) {
    var end = pos + len, s = "";
    while (pos < end) s += String.fromCharCode(pbf[pos++]);
    return s;
  }

  function readPackedVarints(len) {
    var end = pos + len, arr = [];
    while (pos < end) arr.push(readVarint());
    return arr;
  }

  function zigzag(n) { return (n >>> 1) ^ -(n & 1); }

  function decodeGeometry(cmds) {
    var rings = [], ring = null, x = 0, y = 0, i = 0;
    while (i < cmds.length) {
      var cmd = cmds[i++];
      var id = cmd & 0x7;
      var count = cmd >> 3;
      if (id === 1) {
        if (ring && ring.length > 0) rings.push(ring);
        ring = [];
        for (var j = 0; j < count; j++) {
          x += zigzag(cmds[i++]);
          y += zigzag(cmds[i++]);
          ring.push([x, y]);
        }
      } else if (id === 2) {
        for (var j = 0; j < count; j++) {
          x += zigzag(cmds[i++]);
          y += zigzag(cmds[i++]);
          ring.push([x, y]);
        }
      } else if (id === 7) {
        if (ring && ring.length > 0) {
          rings.push(ring);
          ring = null;
        }
      }
    }
    if (ring && ring.length > 0) rings.push(ring);
    return rings;
  }

  var layers = {};
  var end = pbf.length;

  while (pos < end) {
    var tag = readVarint();
    var fieldNum = tag >> 3;
    var wireType = tag & 0x7;

    if (fieldNum === 3 && wireType === 2) {
      var layerLen = readVarint();
      var layerEnd = pos + layerLen;
      var layerName = "";
      var features = [];
      var extent = 4096;

      while (pos < layerEnd) {
        var lt = readVarint();
        var lfn = lt >> 3;
        var lwt = lt & 0x7;

        if (lfn === 1 && lwt === 2) {
          var nl = readVarint();
          layerName = readString(nl);
        } else if (lfn === 2 && lwt === 2) {
          var fl = readVarint();
          var fe = pos + fl;
          var geomType = 0;
          var geomCmds = [];

          while (pos < fe) {
            var ft = readVarint();
            var ffn = ft >> 3;
            var fwt = ft & 0x7;

            if (ffn === 3 && fwt === 0) {
              geomType = readVarint();
            } else if (ffn === 4 && fwt === 2) {
              var gl = readVarint();
              geomCmds = readPackedVarints(gl);
            } else {
              skip(fwt);
            }
          }
          if (geomType === 3 && geomCmds.length) {
            features.push(decodeGeometry(geomCmds));
          }
        } else if (lfn === 5 && lwt === 0) {
          extent = readVarint();
        } else {
          skip(lwt);
        }
      }

      if (features.length) {
        layers[layerName] = { features: features, extent: extent };
      }
    } else {
      skip(wireType);
    }
  }

  return layers;
}

self.onmessage = function (e) {
  var id = e.data.id;
  var buf = e.data.buffer;
  var decoded = decodeMVT(buf);
  var layer = decoded["sidewalks"] || null;
  self.postMessage({ id: id, layer: layer });
};
