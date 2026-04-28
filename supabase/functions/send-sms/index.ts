const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method === "GET") {
    return jsonResponse(
      {
        smsEnabled: Boolean(
          Deno.env.get("TWILIO_ACCOUNT_SID") &&
            Deno.env.get("TWILIO_AUTH_TOKEN") &&
            Deno.env.get("TWILIO_FROM_NUMBER"),
        ),
      },
      200,
    );
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const accountSid = Deno.env.get("TWILIO_ACCOUNT_SID") || "";
  const authToken = Deno.env.get("TWILIO_AUTH_TOKEN") || "";
  const fromNumber = Deno.env.get("TWILIO_FROM_NUMBER") || "";

  if (!accountSid || !authToken || !fromNumber) {
    return jsonResponse({ error: "Twilio secrets are not configured." }, 503);
  }

  const body = await request.json().catch(() => null);
  const to = sanitizePhone(body?.to);
  const messageBody = String(body?.body || "").trim();

  if (!to || !messageBody) {
    return jsonResponse({ error: "A destination phone number and message body are required." }, 400);
  }

  const authHeader = `Basic ${btoa(`${accountSid}:${authToken}`)}`;
  const twilioResponse = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      From: fromNumber,
      To: to,
      Body: messageBody,
    }),
  });

  const twilioPayload = await twilioResponse.json().catch(() => ({}));

  if (!twilioResponse.ok) {
    return jsonResponse(
      { error: twilioPayload.message || "Twilio failed to send the message." },
      502,
    );
  }

  return jsonResponse(
    {
      ok: true,
      sid: twilioPayload.sid,
      status: twilioPayload.status,
    },
    200,
  );
});

function sanitizePhone(value: unknown) {
  const digits = String(value || "").replace(/[^\d+]/g, "");
  if (!digits) return "";
  if (digits.startsWith("+")) return digits;
  if (digits.length === 10) return `+1${digits}`;
  return `+${digits}`;
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}
