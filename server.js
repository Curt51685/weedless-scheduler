const http = require("node:http");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");

const rootDir = __dirname;
loadEnvFile(path.join(rootDir, ".env"));
const port = Number(process.env.PORT || 4173);
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

const twilioConfig = {
  accountSid: process.env.TWILIO_ACCOUNT_SID || "",
  authToken: process.env.TWILIO_AUTH_TOKEN || "",
  fromNumber: process.env.TWILIO_FROM_NUMBER || "",
};

const smsEnabled = Boolean(twilioConfig.accountSid && twilioConfig.authToken && twilioConfig.fromNumber);

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || `127.0.0.1:${port}`}`);

    if (requestUrl.pathname === "/api/status" && req.method === "GET") {
      return sendJson(res, 200, { smsEnabled });
    }

    if (requestUrl.pathname === "/api/send-sms" && req.method === "POST") {
      return handleSendSms(req, res);
    }

    return serveStaticFile(requestUrl.pathname, res);
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { error: "Server error" });
  }
});

server.listen(port, () => {
  console.log(`Weedless Scheduler running at http://127.0.0.1:${port}`);
  if (smsEnabled) {
    console.log("Twilio SMS sending is enabled.");
  } else {
    console.log("Twilio SMS sending is not configured. App will fall back to copy-to-clipboard.");
  }
});

async function handleSendSms(req, res) {
  if (!smsEnabled) {
    return sendJson(res, 503, { error: "Twilio is not configured on this server." });
  }

  const body = await readJsonBody(req);
  const to = sanitizePhone(body?.to);
  const messageBody = String(body?.body || "").trim();

  if (!to || !messageBody) {
    return sendJson(res, 400, { error: "A destination phone number and message body are required." });
  }

  try {
    const message = await sendTwilioSms({ to, body: messageBody });

    return sendJson(res, 200, {
      ok: true,
      sid: message.sid,
      status: message.status,
    });
  } catch (error) {
    console.error("Twilio send failed:", error);
    return sendJson(res, 502, {
      error: error?.message || "Twilio failed to send the message.",
    });
  }
}

async function serveStaticFile(requestPath, res) {
  const normalizedPath = requestPath === "/" ? "/index.html" : requestPath;
  const filePath = path.join(rootDir, normalizedPath);
  const safePath = path.normalize(filePath);

  if (!safePath.startsWith(rootDir)) {
    return sendText(res, 403, "Forbidden");
  }

  try {
    const contents = await fs.readFile(safePath);
    const extension = path.extname(safePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": mimeTypes[extension] || "application/octet-stream",
      "Cache-Control": extension === ".html" ? "no-cache" : "public, max-age=3600",
    });
    res.end(contents);
  } catch {
    if (normalizedPath !== "/index.html") {
      return serveStaticFile("/index.html", res);
    }
    sendText(res, 404, "Not found");
  }
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

function sanitizePhone(value) {
  const digits = String(value || "").replace(/[^\d+]/g, "");
  if (!digits) return "";
  if (digits.startsWith("+")) return digits;
  if (digits.length === 10) return `+1${digits}`;
  return `+${digits}`;
}

async function sendTwilioSms({ to, body }) {
  const auth = Buffer.from(`${twilioConfig.accountSid}:${twilioConfig.authToken}`).toString("base64");
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioConfig.accountSid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      From: twilioConfig.fromNumber,
      To: to,
      Body: body,
    }),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.message || "Twilio failed to send the message.");
  }
  return payload;
}

function loadEnvFile(filePath) {
  if (!fsSync.existsSync(filePath)) return;
  const contents = fsSync.readFileSync(filePath, "utf-8");
  contents.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const separator = trimmed.indexOf("=");
    if (separator === -1) return;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (key && !process.env[key]) {
      process.env[key] = value;
    }
  });
}

function sendJson(res, statusCode, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function sendText(res, statusCode, message) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(message);
}
