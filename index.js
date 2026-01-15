/**
 * Komodo Cruises Backend API
 * Express.js Server for Coolify Deployment
 */
import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

/**
 * KONFIGURASI
 */
const GOOGLE_API_KEY =
  process.env.GOOGLE_API_KEY || "AIzaSyCaBu5hbQiZQbt8wl10bJzM08jFVuGeSuI";
const SPREADSHEET_ID =
  process.env.SPREADSHEET_ID || "1FqMYrf_uVoL_lU2WuoFj_59rXPHttuAqDI_mxnVN42I";
const SHEET_NAME = "2026 OT (Normalized)";
const CABIN_DETAIL_SHEET = "Cabin Detail";
const SHIP_DETAIL_SHEET = "Ship Detail";

const OT2026 = [
  "SEMESTA VOYAGES",
  "AKASSA CRUISE",
  "DERYA LIVEABOARD",
  "GIONA LIVEABOARD",
];

// In-memory cache
const sheetCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/* =======================================================================
 * API ROUTES
 * =======================================================================*/

// Health check
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    status: "healthy",
    timestamp: new Date().toISOString(),
  });
});

// Main API endpoint
app.get("/", async (req, res) => {
  const resource = (req.query.resource || "").toLowerCase().trim();
  const date = req.query.date;
  const cabinName = req.query.name;
  const guests = parseInt(req.query.guests || "1", 10);
  const sheet = req.query.sheet;

  try {
    // === API: Cabin Detail ===
    if (resource === "cabindetail") {
      const details = await loadCabinDetailCached();

      if (cabinName) {
        const found = details.find(
          (c) => c.cabin_name?.toUpperCase() === cabinName.toUpperCase()
        );
        if (!found) return jsonErr(res, `Cabin '${cabinName}' not found`);
        return jsonOk(res, { data: found });
      }
      return jsonOk(res, { total: details.length, data: details });
    }

    // === API: Ship Detail ===
    if (resource === "shipdetail") {
      try {
        const shipDetailUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(
          SHIP_DETAIL_SHEET
        )}?key=${GOOGLE_API_KEY}`;

        const shipResp = await fetch(shipDetailUrl);
        if (!shipResp.ok) {
          return jsonErr(res, `Gagal fetch Ship Detail: ${shipResp.status}`);
        }

        const shipJson = await shipResp.json();
        const shipRows = shipJson.values || [];

        if (shipRows.length < 2) {
          return jsonOk(res, {
            ok: true,
            total: 0,
            resource: "shipdetail",
            ships: [],
          });
        }

        const headers = shipRows[0].map((h) => (h || "").toLowerCase().trim());
        const ships = [];

        for (let i = 1; i < shipRows.length; i++) {
          const row = shipRows[i] || [];
          const obj = {};
          headers.forEach((h, idx) => {
            const v = (row[idx] || "").toString().trim();
            if (h) obj[h] = v;
          });

          const shipName =
            obj["name boat"] || obj["op name"] || obj["operator"] || "";
          if (!shipName) continue;

          const description = obj["description"] || "";
          let mainImage = obj["main display"] || "";

          if (mainImage && mainImage.includes("drive.google.com")) {
            mainImage = convertGoogleDriveUrl(mainImage);
          }

          const images = [];
          if (mainImage) images.push(mainImage);

          for (let j = 1; j <= 20; j++) {
            const picKey = `picture_${j}`;
            let picUrl = obj[picKey];
            if (picUrl && picUrl.includes("drive.google.com")) {
              picUrl = convertGoogleDriveUrl(picUrl);
              if (!images.includes(picUrl)) images.push(picUrl);
            }
          }

          ships.push({
            name: shipName,
            description: description,
            image_main: mainImage,
            images: images,
          });
        }

        return jsonOk(res, {
          ok: true,
          total: ships.length,
          resource: "shipdetail",
          ships,
        });
      } catch (err) {
        return jsonErr(res, `shipdetail error: ${err.message}`);
      }
    }

    // === API: Operators ===
    if (resource === "operators") {
      return jsonOk(res, {
        total: OT2026.length,
        operators: OT2026.map((x) => ({
          operator: x,
          sourceSheet: `${x} (Normalized)`,
        })),
      });
    }

    // === API: Cabins List ===
    if (resource === "cabins") {
      const sheetName = sheet || SHEET_NAME;
      const sheetData = await loadSheetDataCached(sheetName);
      const allCabins = listCabinsAll(sheetData);
      return jsonOk(res, { cabins: allCabins });
    }

    // Validasi Date untuk Availability & Search
    if (!date) return jsonErr(res, "Missing ?date=YYYY-MM-DD");

    // === Fetch Main Data (Normalized) ===
    const sheetName = sheet || SHEET_NAME;
    const sheetData = await loadSheetDataCached(sheetName);
    const result = summarizeOT2026ByDate(sheetData, date);

    if (resource === "availability") {
      return jsonOk(res, { date, ...result });
    }

    if (resource === "search") {
      if (!cabinName) return jsonErr(res, "Missing ?name=cabinName");

      const cabinNorm = normalizeCabinName(cabinName);
      const matches = [];

      result.operators.forEach((op) => {
        const found = op.cabins.find(
          (c) => c.name.toUpperCase() === cabinNorm.toUpperCase()
        );
        if (found && found.available >= guests) {
          matches.push({ operator: op.operator, available: found.available });
        }
      });

      return jsonOk(res, { date, cabin: cabinNorm, guests, matches });
    }

    return jsonErr(
      res,
      "Unknown resource. Use: cabindetail, shipdetail, operators, cabins, availability, search"
    );
  } catch (err) {
    console.error("API Error:", err);
    return jsonErr(res, err.message);
  }
});

/* =======================================================================
 * DATA FETCHING LAYERS
 * =======================================================================*/

async function loadSheetDataCached(sheetName) {
  const cacheKey = `sheet-data-${sheetName}`;

  if (sheetCache.has(cacheKey)) {
    const cached = sheetCache.get(cacheKey);
    const age = Date.now() - cached.timestamp;
    if (age < CACHE_TTL_MS) {
      console.log(`[Cache HIT] ${sheetName} (age: ${Math.round(age / 1000)}s)`);
      return cached.data;
    } else {
      console.log(`[Cache EXPIRED] ${sheetName}`);
      sheetCache.delete(cacheKey);
    }
  }

  console.log(`[Cache MISS] ${sheetName} - fetching from Google Sheets`);

  const apiUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}?includeGridData=true&ranges=${encodeURIComponent(
    sheetName
  )}&fields=sheets(data(rowData(values(formattedValue,userEnteredFormat(backgroundColor)))))&key=${GOOGLE_API_KEY}`;

  const resp = await fetch(apiUrl);
  if (!resp.ok) {
    const errorText = await resp.text();
    throw new Error(
      `Gagal fetch Google Sheets API (${resp.status}): ${errorText}`
    );
  }
  const json = await resp.json();

  if (!json.sheets || !json.sheets[0]) throw new Error("Sheet not found");

  const rows = json.sheets[0].data[0].rowData || [];
  const values = [];
  const backgrounds = [];

  rows.forEach((row) => {
    const valRow = [];
    const bgRow = [];
    if (row.values) {
      row.values.forEach((cell) => {
        valRow.push(cell.formattedValue || "");
        const color = cell.userEnteredFormat?.backgroundColor || {};
        const isWhite =
          (!color.red && !color.green && !color.blue) ||
          (color.red === 1 && color.green === 1 && color.blue === 1);
        bgRow.push(isWhite ? "#ffffff" : "#colored");
      });
    }
    values.push(valRow);
    backgrounds.push(bgRow);
  });

  const result = { values, backgrounds };

  sheetCache.set(cacheKey, {
    data: result,
    timestamp: Date.now(),
  });

  console.log(`[Cache STORED] ${sheetName}`);
  return result;
}

async function loadCabinDetailCached() {
  const cacheKey = "cabin-detail-data";

  if (sheetCache.has(cacheKey)) {
    const cached = sheetCache.get(cacheKey);
    const age = Date.now() - cached.timestamp;
    if (age < CACHE_TTL_MS) {
      console.log(`[Cache HIT] Cabin Detail (age: ${Math.round(age / 1000)}s)`);
      return cached.data;
    } else {
      console.log(`[Cache EXPIRED] Cabin Detail`);
      sheetCache.delete(cacheKey);
    }
  }

  console.log(`[Cache MISS] Cabin Detail - fetching from Google Sheets`);

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(
    CABIN_DETAIL_SHEET
  )}?key=${GOOGLE_API_KEY}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const errorText = await resp.text();
    throw new Error(`Gagal fetch Cabin Detail (${resp.status}): ${errorText}`);
  }
  const json = await resp.json();
  const rows = json.values;
  if (!rows || rows.length < 2) return [];

  const headers = rows[0].map((h) => (h || "").toLowerCase().trim());

  const list = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const obj = {};
    headers.forEach((h, idx) => {
      const v = (row[idx] || "").toString().trim();
      if (h && v !== "") obj[h] = v;
    });

    if (!obj["name cabin"]) continue;

    const api_name = (obj["name cabin api"] || "").toUpperCase().trim();
    const cabin_name = obj["name cabin"].trim();
    const operator = obj["name boat"] || "Unknown";
    const description = obj["description"] || "";

    const baseCap = Number(obj["base capacity"] || 0);
    const extraCap = Number(obj["extra pax capacity"] || 0);
    let capacity = baseCap + extraCap;
    if (!capacity)
      capacity = Number(obj["total capacity"] || obj["capacity"] || 0);

    const priceRaw = obj["price"] || obj["komodo cruises-pricing"] || "";
    const price =
      Number((priceRaw || "").toString().replace(/[^\d]/g, "")) || 0;

    const trip_days = Number(obj["trip (days)"] || obj["days"] || 0);

    const images = [];
    Object.values(obj).forEach((v) => {
      if (typeof v === "string" && /^https?:\/\//i.test(v)) images.push(v);
    });
    const image_main = images[0] || "";

    list.push({
      api_name,
      cabin_name,
      operator,
      description,
      capacity,
      price,
      trip_days,
      images,
      image_main,
    });
  }

  sheetCache.set(cacheKey, {
    data: list,
    timestamp: Date.now(),
  });

  console.log(`[Cache STORED] Cabin Detail - ${list.length} entries`);
  return list;
}

/* =======================================================================
 * LOGIC CORE
 * =======================================================================*/

function listCabinsAll(sheetData) {
  const out = new Set();
  sheetData.values.forEach((row) => {
    const name = normalizeCabinName(row[0]) || normalizeCabinName(row[1]);
    if (name) out.add(name);
  });
  return [...out].sort();
}

function summarizeOT2026ByDate(sheetData, date) {
  const { values, backgrounds } = sheetData;
  const y = +date.slice(0, 4);
  const m = +date.slice(5, 7);
  const d = +date.slice(8, 10);

  const rows = values.length;
  const cols = rows > 0 ? values[0].length : 0;

  const shipByRow = Array(rows).fill(null);
  let currentShip = null;

  for (let r = 0; r < rows; r++) {
    const cellA = (values[r][0] || "").trim().toUpperCase();
    const cellB = (values[r][1] || "").trim().toUpperCase();
    const found = OT2026.find((s) => cellA === s || cellB === s);
    if (found) currentShip = found;
    shipByRow[r] = currentShip;
  }

  const perShip = {};
  OT2026.forEach((s) => (perShip[s] = {}));

  for (let r = 0; r < rows - 1; r++) {
    if (!values[r] || !values[r + 1]) continue;

    const vR0 = (values[r][0] || "").toUpperCase();
    const vR1 = (values[r][1] || "").toUpperCase();
    const vNext0 = (values[r + 1][0] || "").toUpperCase();
    const vNext1 = (values[r + 1][1] || "").toUpperCase();

    if (vR0 !== "NO." || vR1 !== "TYPE OF CABIN") continue;
    if (vNext0 !== "NO." || vNext1 !== "TYPE OF CABIN") continue;

    const monthRow = r;
    const spanRow = r + 1;
    const shipName = shipByRow[r];
    if (!shipName) continue;

    let endRow = spanRow + 1;
    while (endRow < rows && values[endRow] && values[endRow][1]) endRow++;

    for (let c = 2; c < cols; c++) {
      const spanTxt = values[spanRow][c];
      const span = parseDaySpan(spanTxt);
      if (!span) continue;

      let month = detectMonthFromText(values[monthRow][c]) || m;
      if (month !== m) continue;

      const match =
        span.end < span.start
          ? d === span.start
          : d >= span.start && d <= span.end;

      if (!match) continue;

      for (let rr = spanRow + 1; rr < endRow; rr++) {
        if (!values[rr]) continue;

        const raw = values[rr][1];
        const name = normalizeCabinName(raw);
        if (!name) continue;

        const txt = (values[rr][c] || "").trim();
        const bgClr =
          backgrounds[rr] && backgrounds[rr][c]
            ? backgrounds[rr][c]
            : "#ffffff";

        const empty = txt === "";
        const white = bgClr === "#ffffff";

        if (empty && white) {
          perShip[shipName][name] = (perShip[shipName][name] || 0) + 1;
        }
      }
    }
  }

  const operators = [];
  let total = 0;

  OT2026.forEach((op) => {
    const map = perShip[op] || {};
    const cabins = Object.keys(map)
      .sort()
      .map((raw) => ({
        name: raw,
        available: map[raw],
      }));

    const t = cabins.reduce((s, c) => s + c.available, 0);
    total += t;
    operators.push({ operator: op, total: t, cabins });
  });

  return { total, operators };
}

/* =======================================================================
 * UTILS
 * =======================================================================*/

function parseDaySpan(txt) {
  if (!txt) return null;
  const str = txt.toString();
  const m = str.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  if (m) return { start: +m[1], end: +m[2] };
  const n = str.match(/^(\d{1,2})$/);
  if (n) return { start: +n[1], end: +n[1] };
  return null;
}

function detectMonthFromText(txt) {
  if (!txt) return null;
  const t = txt.toString().toUpperCase();
  if (t.includes("FEB")) return 2;
  if (t.includes("MAR")) return 3;
  if (t.includes("APR")) return 4;
  if (t.includes("MEI") || t.includes("MAY")) return 5;
  if (t.includes("JUN")) return 6;
  if (t.includes("JUL")) return 7;
  if (t.includes("AUG") || t.includes("AGU")) return 8;
  if (t.includes("SEP")) return 9;
  if (t.includes("OCT") || t.includes("OKT")) return 10;
  if (t.includes("NOV")) return 11;
  if (t.includes("DEC") || t.includes("DES")) return 12;
  return null;
}

function normalizeCabinName(txt) {
  if (!txt) return null;
  const clean = txt
    .toString()
    .replace(/^\d+[\.\-\)]*/, "")
    .trim();
  if (!clean) return null;
  return clean.charAt(0).toUpperCase() + clean.slice(1).toLowerCase();
}

function convertGoogleDriveUrl(url) {
  if (!url) return "";
  let fileId = null;
  const match1 = url.match(/\/file\/d\/([^\/]+)/);
  if (match1) {
    fileId = match1[1];
  } else {
    const match2 = url.match(/[?&]id=([^&]+)/);
    if (match2) fileId = match2[1];
  }
  if (!fileId) return url;
  return `https://lh3.googleusercontent.com/d/${fileId}`;
}

function jsonOk(res, obj) {
  res.json({ ok: true, ...obj });
}

function jsonErr(res, error) {
  res.status(400).json({ ok: false, error });
}

/* =======================================================================
 * START SERVER
 * =======================================================================*/

app.listen(PORT, () => {
  console.log(`🚀 Komodo Cruises Backend running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/health`);
  console.log(`📍 API: http://localhost:${PORT}/?resource=cabindetail`);
});
