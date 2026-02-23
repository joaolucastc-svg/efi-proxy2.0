const express = require("express");
const https = require("https");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const PROXY_SECRET = process.env.PROXY_SECRET || "";
const EFI_CLIENT_ID = process.env.EFI_CLIENT_ID || "";
const EFI_CLIENT_SECRET = process.env.EFI_CLIENT_SECRET || "";
const EFI_CERTIFICATE_BASE64 = process.env.EFI_CERTIFICATE_BASE64 || "";
const EFI_PIX_KEY = process.env.EFI_PIX_KEY || "";

/* =========================
   HTTPS mTLS Agent
========================= */
function getHttpsAgent() {
  const pfx = Buffer.from(EFI_CERTIFICATE_BASE64, "base64");
  return new https.Agent({
    pfx,
    passphrase: "",
    rejectUnauthorized: true
  });
}

/* =========================
   Auth Middleware
========================= */
function authMiddleware(req, res, next) {
  if (!PROXY_SECRET || req.headers["x-proxy-secret"] !== PROXY_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

/* =========================
   Generic HTTPS Request
========================= */
function makeRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";

      res.on("data", (chunk) => (data += chunk));

      res.on("end", () => {
        try {
          resolve({
            status: res.statusCode,
            data: JSON.parse(data)
          });
        } catch {
          resolve({
            status: res.statusCode,
            data
          });
        }
      });
    });

    req.on("error", reject);

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/* =========================
   Get OAuth Token
========================= */
async function getEfiToken() {
  const credentials = Buffer.from(
    `${EFI_CLIENT_ID}:${EFI_CLIENT_SECRET}`
  ).toString("base64");

  const response = await makeRequest(
    {
      hostname: "pix.api.efipay.com.br",
      path: "/oauth/token",
      method: "POST",
      agent: getHttpsAgent(),
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/json"
      }
    },
    { grant_type: "client_credentials" }
  );

  if (response.status !== 200) {
    console.error("EFI AUTH ERROR:", response.data);
    throw new Error("EFI auth failed");
  }

  return response.data.access_token;
}

/* =========================
   Health Check
========================= */
app.get("/", (req, res) =>
  res.json({ status: "ok", service: "efi-mtls-proxy" })
);

/* =========================
   CREATE PIX CHARGE (DEPOSIT)
========================= */
app.post("/create-charge", authMiddleware, async (req, res) => {
  try {
    const { amount, txid, user_id } = req.body;

    if (!amount || !txid)
      return res.status(400).json({ error: "Missing amount or txid" });

    const token = await getEfiToken();
    const agent = getHttpsAgent();

    const chargeResponse = await makeRequest(
      {
        hostname: "pix.api.efipay.com.br",
        path: `/v2/cob/${txid}`,
        method: "PUT",
        agent,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        }
      },
      {
        calendario: { expiracao: 3600 },
        valor: { original: parseFloat(amount).toFixed(2) },
        chave: EFI_PIX_KEY,
        infoAdicionais: [
          { nome: "Plataforma", valor: "X1Stars" },
          { nome: "User", valor: user_id || "unknown" }
        ]
      }
    );

    if (![200, 201].includes(chargeResponse.status)) {
      return res
        .status(chargeResponse.status)
        .json({ error: "Charge failed", details: chargeResponse.data });
    }

    const charge = chargeResponse.data;
    let qrCode = "";
    let qrCodeImage = "";

    if (charge.loc && charge.loc.id) {
      const qrResponse = await makeRequest({
        hostname: "pix.api.efipay.com.br",
        path: `/v2/loc/${charge.loc.id}/qrcode`,
        method: "GET",
        agent,
        headers: { Authorization: `Bearer ${token}` }
      });

      if (qrResponse.status === 200) {
        qrCode = qrResponse.data.qrcode || "";
        qrCodeImage = qrResponse.data.imagemQrcode || "";
      }
    }

    res.json({
      charge,
      qr_code: qrCode,
      qr_code_image: qrCodeImage,
      pix_copy_paste: charge.pixCopiaECola || qrCode
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

/* =========================
   SEND PIX (PAYOUT / SAQUE)
========================= */
app.post("/send-pix", authMiddleware, async (req, res) => {
  try {
    const { pix_key, amount } = req.body;

    if (!pix_key || !amount)
      return res.status(400).json({ error: "Missing pix_key or amount" });

    const token = await getEfiToken();
    const agent = getHttpsAgent();

    const idEnvio = `x1payout${Date.now()}`;

    const payoutResponse = await makeRequest(
      {
        hostname: "pix.api.efipay.com.br",
        path: `/v2/gn/pix/${idEnvio}`, // ✅ ENDPOINT CORRETO
        method: "PUT",
        agent,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        }
      },
      {
        valor: parseFloat(amount).toFixed(2),
        favorecido: {
          chave: pix_key
        }
      }
    );

    if (![200, 201].includes(payoutResponse.status)) {
      console.error("PAYOUT ERROR:", payoutResponse.data);
      return res.status(payoutResponse.status).json({
        error: "Payout failed",
        details: payoutResponse.data
      });
    }

    res.json({
      success: true,
      idEnvio,
      e2eid: payoutResponse.data.e2eId || null,
      data: payoutResponse.data
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

/* =========================
   REGISTER WEBHOOK
========================= */
app.post("/register-webhook", authMiddleware, async (req, res) => {
  try {
    const { webhook_url } = req.body;

    if (!webhook_url)
      return res.status(400).json({ error: "Missing webhook_url" });

    const token = await getEfiToken();

    const response = await makeRequest(
      {
        hostname: "pix.api.efipay.com.br",
        path: `/v2/webhook/${encodeURIComponent(EFI_PIX_KEY)}`,
        method: "PUT",
        agent: getHttpsAgent(),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "x-skip-mtls-checking": "true"
        }
      },
      { webhookUrl: webhook_url }
    );

    if (![200, 201].includes(response.status)) {
      return res
        .status(response.status)
        .json({ error: "Webhook failed", details: response.data });
    }

    res.json({ success: true, data: response.data });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

/* =========================
   GET BALANCE
========================= */
app.get("/balance", authMiddleware, async (req, res) => {
  try {
    const token = await getEfiToken();

    const response = await makeRequest({
      hostname: "pix.api.efipay.com.br",
      path: "/v2/gn/saldo",
      method: "GET",
      agent: getHttpsAgent(),
      headers: { Authorization: `Bearer ${token}` }
    });

    res.json(response.data);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

/* =========================
   START SERVER
========================= */
app.listen(PORT, () =>
  console.log(`EFI mTLS Proxy running on port ${PORT}`)
);
