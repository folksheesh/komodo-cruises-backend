/**
 * Komodo Cruises Backend API
 * Express.js Server for Coolify Deployment
 */
import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import { Resend } from "resend";

const app = express();
const PORT = process.env.PORT || 3000;

// =======================================================================
// XENDIT & EMAIL CONFIGURATION
// =======================================================================

// Xendit API Key (Development) - Move to env var in production
const XENDIT_SECRET_KEY =
  process.env.XENDIT_SECRET_KEY ||
  "xnd_development_dGXj21II2TZ60PFab6N5UDTu3SQZzC5qJpkPfoW7eoSaz2Hwvz0sw4dnD5EhM6g";
const XENDIT_AUTH = Buffer.from(XENDIT_SECRET_KEY + ":").toString("base64");

// Resend Email Configuration
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || "booking@komodocruises.com";

// Make Resend optional - only initialize if API key is present
let resend = null;
if (RESEND_API_KEY) {
  resend = new Resend(RESEND_API_KEY);
  console.log("✅ Resend email service initialized");
} else {
  console.warn("⚠️  RESEND_API_KEY is not set. Email sending is disabled.");
}

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
 * XENDIT PAYMENT ENDPOINTS
 * =======================================================================*/

// Create Xendit Invoice
app.post("/api/create-invoice", async (req, res) => {
  try {
    const {
      externalId,
      amount,
      payerEmail,
      description,
      customerName,
      customerPhone,
      items,
      successRedirectUrl,
      failureRedirectUrl,
    } = req.body;

    console.log("Received create-invoice request:", req.body);

    // Validate required fields
    if (!amount || !payerEmail || !description) {
      return res.status(400).json({
        success: false,
        message: `Missing required fields: ${!amount ? "amount" : ""} ${
          !payerEmail ? "payerEmail" : ""
        } ${!description ? "description" : ""}`.trim(),
      });
    }

    // Generate external ID if not provided
    const invoiceExternalId =
      externalId ||
      `INV-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Prepare invoice data for Xendit API
    const invoiceData = {
      external_id: invoiceExternalId,
      amount: Number(amount),
      payer_email: payerEmail,
      description: description,
      currency: "IDR",
      invoice_duration: 86400,
      success_redirect_url:
        successRedirectUrl || "https://komodocruises.com/payment-success",
      failure_redirect_url:
        failureRedirectUrl || "https://komodocruises.com/payment-failed",
    };

    // Add customer if provided
    if (customerName || customerPhone) {
      invoiceData.customer = {
        given_names: customerName || "Customer",
        email: payerEmail,
      };
      if (customerPhone) {
        invoiceData.customer.mobile_number = customerPhone;
      }
    }

    // Add items if provided
    if (items && items.length > 0) {
      invoiceData.items = items.map((item) => ({
        name: item.name,
        quantity: item.quantity || 1,
        price: item.price,
        category: item.category || "Cruise Booking",
      }));
    }

    console.log(
      "Creating Xendit invoice with data:",
      JSON.stringify(invoiceData, null, 2)
    );

    // Call Xendit API directly
    const response = await fetch("https://api.xendit.co/v2/invoices", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${XENDIT_AUTH}`,
      },
      body: JSON.stringify(invoiceData),
    });

    const responseData = await response.json();

    console.log("Xendit API response:", responseData);

    if (!response.ok) {
      console.error("Xendit API error:", responseData);
      return res.status(response.status).json({
        success: false,
        message: responseData.message || "Failed to create invoice",
        errorCode: responseData.error_code,
      });
    }

    res.json({
      success: true,
      invoiceId: responseData.id,
      invoiceUrl: responseData.invoice_url,
      externalId: responseData.external_id,
      status: responseData.status,
      amount: responseData.amount,
      expiryDate: responseData.expiry_date,
    });
  } catch (error) {
    console.error("Error creating Xendit invoice:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error while creating invoice",
      error: error.message,
    });
  }
});

// Get Invoice Status
app.get("/api/invoice/:invoiceId", async (req, res) => {
  try {
    const { invoiceId } = req.params;

    const response = await fetch(
      `https://api.xendit.co/v2/invoices/${invoiceId}`,
      {
        method: "GET",
        headers: {
          Authorization: `Basic ${XENDIT_AUTH}`,
        },
      }
    );

    const responseData = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        success: false,
        message: responseData.message || "Failed to fetch invoice",
      });
    }

    res.json({
      success: true,
      invoice: responseData,
    });
  } catch (error) {
    console.error("Error fetching invoice:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch invoice",
      error: error.message,
    });
  }
});

// Webhook endpoint for Xendit callbacks
app.post("/api/xendit-webhook", (req, res) => {
  try {
    const webhookData = req.body;
    console.log("Received Xendit webhook:", webhookData);

    // Handle different webhook events
    switch (webhookData.status) {
      case "PAID":
        console.log(`Invoice ${webhookData.external_id} has been paid!`);
        // TODO: Update booking status in database
        break;
      case "EXPIRED":
        console.log(`Invoice ${webhookData.external_id} has expired`);
        // TODO: Handle expired invoice
        break;
      default:
        console.log(`Invoice status: ${webhookData.status}`);
    }

    res.json({ received: true });
  } catch (error) {
    console.error("Webhook error:", error);
    res.status(500).json({ error: "Webhook processing failed" });
  }
});

/* =======================================================================
 * EMAIL FUNCTIONALITY
 * =======================================================================*/

// Generate email HTML template
function generateEmailHTML(data) {
  const formatCurrency = (amount) => {
    return new Intl.NumberFormat("id-ID", {
      style: "currency",
      currency: "IDR",
      minimumFractionDigits: 0,
    }).format(amount || 0);
  };

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Booking Confirmation - Komodo Cruises</title>
</head>
<body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f4f4f4;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 600px; margin: 0 auto; background-color: #ffffff;">
    <!-- Header -->
    <tr>
      <td style="background: linear-gradient(135deg, #1a365d 0%, #2d4a6f 100%); padding: 40px 30px; text-align: center;">
        <h1 style="color: #ffffff; margin: 0; font-size: 28px; font-weight: 600;">🚢 Komodo Cruises</h1>
        <p style="color: rgba(255,255,255,0.8); margin: 10px 0 0; font-size: 16px;">Booking Confirmation</p>
      </td>
    </tr>
    
    <!-- Success Badge -->
    <tr>
      <td style="padding: 30px 30px 20px; text-align: center;">
        <div style="display: inline-block; background-color: #dcfce7; color: #166534; padding: 12px 24px; border-radius: 50px; font-weight: 600;">
          ✓ Payment Successful
        </div>
      </td>
    </tr>
    
    <!-- Greeting -->
    <tr>
      <td style="padding: 0 30px 20px;">
        <h2 style="color: #1a365d; margin: 0 0 10px; font-size: 24px;">Thank You for Your Purchase!</h2>
        <p style="color: #64748b; margin: 0; font-size: 15px; line-height: 1.6;">
          Dear ${data.customerName},<br><br>
          Your booking has been confirmed. Below are your booking details and payment receipt.
        </p>
      </td>
    </tr>
    
    <!-- Booking ID -->
    <tr>
      <td style="padding: 0 30px 20px;">
        <table width="100%" style="background: #f8fafc; border-radius: 12px; padding: 20px;">
          <tr>
            <td style="padding: 15px;">
              <p style="margin: 0 0 5px; font-size: 12px; color: #64748b; text-transform: uppercase;">Booking ID</p>
              <p style="margin: 0; font-size: 20px; font-weight: 600; color: #1a365d; font-family: monospace;">#${
                data.bookingId
              }</p>
            </td>
            <td style="padding: 15px; text-align: right;">
              <p style="margin: 0 0 5px; font-size: 12px; color: #64748b; text-transform: uppercase;">Date</p>
              <p style="margin: 0; font-size: 16px; color: #1a365d;">${new Date().toLocaleDateString(
                "en-GB",
                { day: "numeric", month: "long", year: "numeric" }
              )}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
    
    <!-- Guest Information -->
    <tr>
      <td style="padding: 0 30px 20px;">
        <h3 style="color: #1a365d; margin: 0 0 15px; font-size: 16px; border-bottom: 2px solid #e2e8f0; padding-bottom: 10px;">
          👤 Guest Information
        </h3>
        <table width="100%" cellpadding="8">
          <tr>
            <td style="color: #64748b; font-size: 14px; width: 120px;">Name:</td>
            <td style="color: #1e293b; font-size: 14px; font-weight: 500;">${
              data.customerName
            }</td>
          </tr>
          <tr>
            <td style="color: #64748b; font-size: 14px;">Email:</td>
            <td style="color: #1e293b; font-size: 14px; font-weight: 500;">${
              data.customerEmail
            }</td>
          </tr>
          <tr>
            <td style="color: #64748b; font-size: 14px;">Phone:</td>
            <td style="color: #1e293b; font-size: 14px; font-weight: 500;">${
              data.customerPhone || "-"
            }</td>
          </tr>
        </table>
      </td>
    </tr>
    
    <!-- Trip Details -->
    <tr>
      <td style="padding: 0 30px 20px;">
        <h3 style="color: #1a365d; margin: 0 0 15px; font-size: 16px; border-bottom: 2px solid #e2e8f0; padding-bottom: 10px;">
          🚢 Trip Details
        </h3>
        <table width="100%" cellpadding="8">
          <tr>
            <td style="color: #64748b; font-size: 14px; width: 120px;">Ship:</td>
            <td style="color: #1e293b; font-size: 14px; font-weight: 500;">${
              data.shipName
            }</td>
          </tr>
          <tr>
            <td style="color: #64748b; font-size: 14px;">Cabin Type:</td>
            <td style="color: #1e293b; font-size: 14px; font-weight: 500;">${
              data.cabinName
            }</td>
          </tr>
          <tr>
            <td style="color: #64748b; font-size: 14px;">Itinerary:</td>
            <td style="color: #1e293b; font-size: 14px; font-weight: 500;">${
              data.itinerary || "-"
            }</td>
          </tr>
          <tr>
            <td style="color: #64748b; font-size: 14px;">Travel Date:</td>
            <td style="color: #1e293b; font-size: 14px; font-weight: 500;">${
              data.travelDate
            }</td>
          </tr>
          <tr>
            <td style="color: #64748b; font-size: 14px;">Guests:</td>
            <td style="color: #1e293b; font-size: 14px; font-weight: 500;">${
              data.guests
            } Person(s)</td>
          </tr>
        </table>
      </td>
    </tr>
    
    <!-- Payment Summary -->
    <tr>
      <td style="padding: 0 30px 20px;">
        <h3 style="color: #1a365d; margin: 0 0 15px; font-size: 16px; border-bottom: 2px solid #e2e8f0; padding-bottom: 10px;">
          💳 Payment Summary
        </h3>
        <table width="100%" style="background: #f8fafc; border-radius: 12px;">
          <tr>
            <td style="padding: 15px; color: #64748b; font-size: 14px;">${
              data.cabinName
            } × ${data.guests}</td>
            <td style="padding: 15px; color: #1e293b; font-size: 14px; text-align: right;">${formatCurrency(
              data.pricePerCabin
            )} × ${data.guests}</td>
          </tr>
          <tr>
            <td colspan="2" style="border-top: 2px dashed #e2e8f0;"></td>
          </tr>
          <tr>
            <td style="padding: 15px; color: #1a365d; font-size: 16px; font-weight: 600;">Total Paid</td>
            <td style="padding: 15px; color: #10b981; font-size: 22px; font-weight: 700; text-align: right;">${formatCurrency(
              data.totalAmount
            )}</td>
          </tr>
        </table>
        <div style="background: #dcfce7; color: #166534; padding: 12px; border-radius: 8px; text-align: center; margin-top: 15px; font-weight: 600;">
          ✓ Payment Successful
        </div>
      </td>
    </tr>
    
    <!-- What's Next -->
    <tr>
      <td style="padding: 0 30px 30px;">
        <h3 style="color: #1a365d; margin: 0 0 15px; font-size: 16px;">What Happens Next?</h3>
        <table width="100%">
          <tr>
            <td style="padding: 10px 0;">
              <table>
                <tr>
                  <td style="background: #c99b7b; color: white; width: 28px; height: 28px; border-radius: 50%; text-align: center; font-weight: 600; font-size: 14px;">1</td>
                  <td style="padding-left: 12px; color: #475569; font-size: 14px;">Our Journey Designer will contact you within 24 hours</td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding: 10px 0;">
              <table>
                <tr>
                  <td style="background: #c99b7b; color: white; width: 28px; height: 28px; border-radius: 50%; text-align: center; font-weight: 600; font-size: 14px;">2</td>
                  <td style="padding-left: 12px; color: #475569; font-size: 14px;">We'll finalize your itinerary and travel arrangements</td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding: 10px 0;">
              <table>
                <tr>
                  <td style="background: #c99b7b; color: white; width: 28px; height: 28px; border-radius: 50%; text-align: center; font-weight: 600; font-size: 14px;">3</td>
                  <td style="padding-left: 12px; color: #475569; font-size: 14px;">Get ready for an unforgettable adventure!</td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
    
    <!-- Footer -->
    <tr>
      <td style="background: #1a365d; padding: 30px; text-align: center;">
        <p style="color: rgba(255,255,255,0.8); margin: 0 0 10px; font-size: 14px;">Need help? Contact us at</p>
        <a href="mailto:support@komodocruises.com" style="color: #c99b7b; text-decoration: none; font-weight: 500;">support@komodocruises.com</a>
        <p style="color: rgba(255,255,255,0.5); margin: 20px 0 0; font-size: 12px;">© ${new Date().getFullYear()} Komodo Cruises. All rights reserved.</p>
      </td>
    </tr>
  </table>
</body>
</html>
  `;
}

// Send confirmation email endpoint
app.post("/api/send-confirmation-email", async (req, res) => {
  try {
    const data = req.body || {};

    // Basic validation
    if (!data.customerEmail) {
      return res.status(400).json({
        success: false,
        message: "Missing required field: customerEmail",
      });
    }

    console.log("Sending confirmation email to:", data.customerEmail);

    // Ensure API key present
    if (!RESEND_API_KEY) {
      console.error("RESEND_API_KEY is not configured in the environment.");
      return res
        .status(500)
        .json({ success: false, message: "Email provider not configured" });
    }

    const response = await resend.emails.send({
      from: EMAIL_FROM,
      to: data.customerEmail,
      subject: `✅ Booking Confirmed - ${
        data.bookingId || ""
      } | Komodo Cruises`,
      html: generateEmailHTML(data),
    });

    // Resend SDK may return different shapes; try to extract an id safely
    const sentId =
      response && (response.id || (response.data && response.data.id));

    console.log("Resend response:", response);

    return res.json({
      success: true,
      message: "Email sent successfully",
      id: sentId || null,
      raw: response,
    });
  } catch (error) {
    console.error("Error sending email:", error);

    // If Resend returned a structured error, try to forward useful info
    const errMsg =
      (error && (error.message || (error.error && error.error.message))) ||
      "Unknown error";

    return res.status(500).json({
      success: false,
      message: "Failed to send email",
      error: errMsg,
      details: error,
    });
  }
});

/* =======================================================================
 * START SERVER
 * =======================================================================*/

app.listen(PORT, () => {
  console.log(`🚀 Komodo Cruises Backend running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/health`);
  console.log(`📍 API: http://localhost:${PORT}/?resource=cabindetail`);
  console.log(`📍 Payment: POST http://localhost:${PORT}/api/create-invoice`);
  console.log(
    `📍 Email: POST http://localhost:${PORT}/api/send-confirmation-email`
  );
});
