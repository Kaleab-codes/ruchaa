/* RUCHA GPS engine.
 *
 * Accuracy-hardened replacement for RUCHA_SENSORS.gps from sensors.js. Load this
 * after sensors.js and before app.js; it swaps the GPS object in place and
 * leaves the Bluetooth and wake-lock code untouched.
 *
 * Why this exists: when a browser has no satellite fix it still answers with a
 * network fix (IP or WiFi survey database) whose accuracy is measured in
 * kilometres. The old engine published that fix as the live position, drew an
 * accuracy ring 25 km wide, persisted it in localStorage for six hours and only
 * then let TrackFilter throw it away. The map therefore showed a confident dot
 * in central Addis with 0.00 km recorded.
 */
(function (global) {
  'use strict';

  var RS = global.RUCHA_SENSORS;
  if (!RS) return;

  var EARTH_R = 6371008.8;  // metres, IUGG mean Earth radius
  var D2R = Math.PI / 180;

  /* ---- Accuracy policy ----------------------------------------------------
   * Thresholds are horizontal accuracy in metres (68% confidence radius).
   */
  var STRONG_M = 15;        // open sky, good satellite fix
  var OK_M = 35;            // the normal figure on a phone
  var WEAK_M = 100;         // urban canyon or tree canopy: usable but rough
  var MAX_FIX_M = 400;      // beyond this a "fix" is a guess, not a position

  var LAST_FIX_KEY = 'rucha_last_fix_v2';   // v2 drops positions cached by older builds
  var LAST_FIX_MAX_AGE = 6 * 60 * 60 * 1000; // 6 hours

  var supported = !!navigator.geolocation;
  var secure = global.isSecureContext !== false;

  /* ---- Geometry ----------------------------------------------------------- */

  function distM(a, b) {
    var dLat = (b.lat - a.lat) * D2R, dLng = (b.lng - a.lng) * D2R;
    var la1 = a.lat * D2R, la2 = b.lat * D2R;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(la1) * Math.cos(la2) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  /* ---- Fix validation ----------------------------------------------------- */

  function qualityOf(acc) {
    if (!isFinite(acc) || acc <= 0) return 'none';
    if (acc <= STRONG_M) return 'strong';
    if (acc <= OK_M) return 'ok';
    if (acc <= WEAK_M) return 'weak';
    if (acc <= MAX_FIX_M) return 'coarse';
    return 'none';
  }

  // A fix is only a position if the browser can vouch for it to a few hundred
  // metres. Everything else is the network saying "somewhere in this city".
  function fixUsable(fix) {
    if (!fix) return false;
    if (!isFinite(fix.lat) || !isFinite(fix.lng)) return false;
    if (Math.abs(fix.lat) > 90 || Math.abs(fix.lng) > 180) return false;
    if (fix.lat === 0 && fix.lng === 0) return false;         // Null Island: provider gave up
    var acc = fix.accuracy;
    if (!isFinite(acc) || acc <= 0) return false;             // unverifiable, so not usable
    return acc <= MAX_FIX_M;
  }

  function waitMessage(fix) {
    var acc = fix && fix.accuracy;
    if (isFinite(acc) && acc > 0) {
      return 'No precise GPS fix yet \u2014 the last reading was \u00b1' +
             Math.round(acc) + ' m. Move outside with a clear view of the sky.';
    }
    return 'No GPS fix yet \u2014 move outside with a clear view of the sky.';
  }

  function toFix(pos) {
    var c = pos.coords || {};
    return {
      lat: c.latitude,
      lng: c.longitude,
      ele: (c.altitude != null && isFinite(c.altitude)) ? c.altitude : null,
      eleAcc: (c.altitudeAccuracy != null && isFinite(c.altitudeAccuracy)) ? c.altitudeAccuracy : null,
      accuracy: (c.accuracy != null && isFinite(c.accuracy)) ? c.accuracy : null,
      speed: (c.speed != null && isFinite(c.speed) && c.speed >= 0) ? c.speed : null,
      heading: (c.heading != null && isFinite(c.heading)) ? c.heading : null,
      t: pos.timestamp || Date.now()
    };
  }

  function gpsErr(err) {
    if (!err) return 'GPS unavailable';
    if (err.code === 1) return 'Location permission denied. Allow location for this site in your browser settings.';
    if (err.code === 2) return 'No GPS signal. Move to open sky and try again.';
    if (err.code === 3) return 'GPS timed out waiting for a fix.';
    return err.message || 'GPS unavailable';
  }

  /* ---- Last-fix cache ----------------------------------------------------- */

  function loadLastFix() {
    try {
      var raw = global.localStorage && global.localStorage.getItem(LAST_FIX_KEY);
      if (!raw) return null;
      var f = JSON.parse(raw);
      if (!f || !isFinite(f.lat) || !isFinite(f.lng)) return null;
      if (!f.t || Date.now() - f.t > LAST_FIX_MAX_AGE) return null;
      if (!fixUsable(f)) return null;   // never restore a network-grade position
      return f;
    } catch (e) { return null; }
  }

  function saveLastFix(fix) {
    if (!fixUsable(fix)) return;
    try {
      if (global.localStorage) {
        global.localStorage.setItem(LAST_FIX_KEY, JSON.stringify({
          lat: fix.lat, lng: fix.lng, ele: fix.ele, accuracy: fix.accuracy, t: fix.t
        }));
      }
    } catch (e) {}
  }

  /* ---- Track filter -------------------------------------------------------
   * Takes raw fixes and returns accepted points only:
   *  - drops fixes with poor horizontal accuracy
   *  - drops fixes that imply an impossible speed
   *  - ignores jitter while standing still (accuracy-based dead zone)
   *  - smooths lat/lng with an accuracy-weighted Kalman step
   *  - smooths elevation with a rolling median
   */
  function TrackFilter(opts) {
    opts = opts || {};
    this.maxAcc = opts.maxAccuracy || 40;   // metres
    this.maxSpeed = opts.maxSpeed || 9;     // m/s (32 km/h) run; app raises it for rides
    this.minMove = opts.minMove || 3;       // metres
    this.last = null;
    this.sLat = null; this.sLng = null; this.sVar = null;
    this.eleBuf = [];
    this.gap = false;
  }

  TrackFilter.prototype.reset = function () {
    this.last = null; this.sLat = null; this.sLng = null;
    this.sVar = null; this.eleBuf = []; this.gap = false;
  };

  // After a pause the next accepted point starts a new segment and adds no distance.
  TrackFilter.prototype.markGap = function () { this.gap = true; };

  TrackFilter.prototype.smoothEle = function (ele, acc) {
    if (ele == null) return null;
    if (acc != null && acc > 30) return this.eleBuf.length ? this.eleBuf[this.eleBuf.length - 1] : null;
    this.eleBuf.push(ele);
    if (this.eleBuf.length > 7) this.eleBuf.shift();
    var s = this.eleBuf.slice().sort(function (a, b) { return a - b; });
    return s[Math.floor(s.length / 2)];   // rolling median
  };

  // returns { accept:boolean, point?, stepM, reason? }
  TrackFilter.prototype.push = function (fix) {
    if (!fix || !isFinite(fix.lat) || !isFinite(fix.lng) ||
        Math.abs(fix.lat) > 90 || Math.abs(fix.lng) > 180) {
      return { accept: false, reason: 'invalid' };
    }
    var acc = fix.accuracy;
    if (!isFinite(acc) || acc <= 0) return { accept: false, reason: 'accuracy' };
    if (acc > this.maxAcc) return { accept: false, reason: 'accuracy' };

    // Kalman-style smoothing (variance in m^2). A moving fix gets a higher
    // process noise so the drawn track follows corners instead of lagging behind.
    var spd = (fix.speed != null && isFinite(fix.speed)) ? Math.abs(fix.speed) : 0;
    var q = 5 + Math.min(10, spd * 2.5);   // metres per second
    var lat, lng;
    if (this.sLat == null) {
      this.sLat = fix.lat; this.sLng = fix.lng; this.sVar = acc * acc;
      lat = fix.lat; lng = fix.lng;
    } else {
      var dtS = Math.max(0.001, ((fix.t || Date.now()) - (this.last ? this.last.t : fix.t)) / 1000);
      this.sVar += dtS * q * q;
      var k = this.sVar / (this.sVar + acc * acc);
      this.sLat += k * (fix.lat - this.sLat);
      this.sLng += k * (fix.lng - this.sLng);
      this.sVar = (1 - k) * this.sVar;
      lat = this.sLat; lng = this.sLng;
    }

    var ele = this.smoothEle(fix.ele, fix.eleAcc);
    var pt = {
      lat: lat, lng: lng, ele: ele, accuracy: acc,
      speed: fix.speed, heading: fix.heading, t: fix.t
    };

    if (!this.last || this.gap) {
      this.last = pt; this.gap = false;
      return { accept: true, point: pt, stepM: 0, first: true };
    }

    var step = distM(this.last, pt);
    var dt = Math.max(0.001, (pt.t - this.last.t) / 1000);
    if (step / dt > this.maxSpeed) return { accept: false, reason: 'speed' };

    var dead = Math.max(2, Math.min(acc * 0.35, 8));
    if (step < Math.max(this.minMove, dead)) {
      // Standing still: keep the position, still report so the UI can move the dot.
      return { accept: false, reason: 'still', point: pt };
    }

    this.last = pt;
    return { accept: true, point: pt, stepM: step };
  };

  /* ---- gps API ------------------------------------------------------------ */

  var gps = {
    available: function () { return supported; },

    status: function () {
      return {
        supported: supported,
        watching: watchId != null,
        last: lastFix,
        quality: lastFix ? qualityOf(lastFix.accuracy) : 'none',
        error: lastError,
        secure: secure,
        maxAccuracy: MAX_FIX_M
      };
    },

    // One-shot fix for the "check signal" action. Resolves with a usable fix,
    // or null when the browser can only offer a network-grade guess.
    probe: function (timeoutMs) {
      timeoutMs = timeoutMs || 8000;
      return new Promise(function (resolve) {
        if (!supported) { lastError = 'This browser has no GPS support'; resolve(null); return; }

        function recent() {
          return (lastFix && Date.now() - lastFix.t < 10 * 60 * 1000) ? lastFix : null;
        }

        // A running watch already keeps a fresh fix; reuse it.
        if (watchId != null && recent() && Date.now() - lastFix.t < 120000) { resolve(lastFix); return; }

        var done = false, timer;
        function finish(v) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(v);
        }

        timer = setTimeout(function () { finish(recent()); }, timeoutMs);

        try {
          navigator.geolocation.getCurrentPosition(function (pos) {
            var f = toFix(pos);
            if (!fixUsable(f)) {
              coarse = f;
              lastError = waitMessage(f);
              finish(recent());
              return;
            }
            coarse = null;
            lastFix = f; lastError = null; denied = false;
            saveLastFix(f);
            finish(f);
          }, function (err) {
            lastError = gpsErr(err);
            if (err && err.code === 1) denied = true;
            finish(err && err.code === 1 ? null : recent());
          }, { enableHighAccuracy: true, maximumAge: 0, timeout: timeoutMs });
        } catch (e) {
          lastError = String(e);
          finish(recent());
        }
      });
    },

    start: function (onFix, onError) {
      if (!supported) { if (onError) onError('This browser has no GPS support'); return false; }
      if (onFix) fixCb = onFix;
      if (onError) errCb = onError;

      // Do not hammer watchPosition (and the user with error toasts) while the
      // permission is denied; probe() can recover it once the user allows it.
      if (denied) return false;

      // Keep the existing watch alive; restarting it discards the fix we primed.
      if (watchId != null) return true;

      try {
        watchId = navigator.geolocation.watchPosition(function (pos) {
          var fix = toFix(pos);
          denied = false;

          // Gate before anything else: a network-grade fix must never become
          // the drawn position, the cached fix or a track point.
          if (!fixUsable(fix)) {
            coarse = fix;
            lastError = waitMessage(fix);
            return;
          }

          coarse = null;
          lastFix = fix;
          lastError = null;
          saveLastFix(fix);
          if (fixCb) fixCb(fix);
        }, function (err) {
          lastError = gpsErr(err);
          // A denied permission kills the watch for good; drop the id so a
          // later start can ask again after the user changes the setting.
          if (err && err.code === 1) { watchId = null; denied = true; }
          if (errCb) errCb(lastError, err && err.code);
        }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });

        if (RS.wake) RS.wake.request();
        return true;
      } catch (e) {
        lastError = String(e);
        if (onError) onError(lastError);
        return false;
      }
    },

    stop: function () {
      if (watchId != null && navigator.geolocation && navigator.geolocation.clearWatch) {
        try { navigator.geolocation.clearWatch(watchId); } catch (e) {}
      }
      watchId = null;
      if (RS.wake) RS.wake.release();
    },

    distanceM: distM,
    Filter: TrackFilter,
    quality: qualityOf,
    maxAccuracyM: MAX_FIX_M
  };

  /* ---- state ---------------------------------------------------------------*/

  var watchId = null;
  var lastFix = loadLastFix();   // last usable position, restored across reloads
  var lastError = null;
  var denied = false;
  var coarse = null;             // most recent rejected (network-grade) reading
  var fixCb = null;
  var errCb = null;

  RS.gps = gps;
})(window);
