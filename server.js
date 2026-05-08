import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import express from "express";
import cors from "cors";
import qrcode from "qrcode";
import { createServer } from "http";
import { Server as SocketIO } from "socket.io";
import pino from "pino";
import fs from "fs";

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const io = new SocketIO(httpServer, { cors: { origin: "*" } });

let sock = null;
let qrData = null;
let connectionStatus = "disconnected";

const AUTH_DIR = "./auth_info";

async function connectWA() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    browser: ["SAMS Server", "Chrome", "3.0"],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrData = await qrcode.toDataURL(qr);
      connectionStatus = "qr";
      io.emit("qr", qrData);
      io.emit("status", "qr");
      console.log("QR code generated");
    }

    if (connection === "close") {
      qrData = null;
      const shouldReconnect =
        lastDisconnect?.error instanceof Boom &&
        lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("Connection closed. Reconnect:", shouldReconnect);
      connectionStatus = "disconnected";
      io.emit("status", "disconnected");
      if (shouldReconnect) {
        setTimeout(connectWA, 3000);
      }
    }

    if (connection === "open") {
      qrData = null;
      connectionStatus = "connected";
      io.emit("status", "connected");
      console.log("WhatsApp connected!");
    }
  });
}

// ── Helper: send a WhatsApp message ──────────────────────────
async function sendMessage(phone, message) {
  if (!sock || connectionStatus !== "connected") {
    throw new Error("WhatsApp not connected");
  }
  let num = phone.replace(/\D/g, "");
  if (num.startsWith("0")) num = "92" + num.slice(1);
  if (!num.startsWith("92")) num = "92" + num;
  const jid = num + "@s.whatsapp.net";
  await sock.sendMessage(jid, { text: message });
  console.log(`Message sent to ${jid}`);
}

// ── Routes ───────────────────────────────────────────────────

app.get("/status", (req, res) => {
  if (connectionStatus === "qr" && qrData) {
    return res.json({ status: "qr", qr: qrData });
  }
  res.json({ status: connectionStatus });
});

app.post("/send", async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: "phone and message required" });
  try {
    await sendMessage(phone, message);
    res.json({ success: true });
  } catch (e) {
    console.error("Send error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post("/send-notification", async (req, res) => {
  const { type, data } = req.body;
  if (!type || !data) return res.status(400).json({ error: "type and data required" });

  try {
    const shopName = process.env.SHOP_NAME || "Sam's Skin Care";
    const baseUrl = process.env.BASE_URL || "https://sams.g0vi.pk";
    const adminPhone = process.env.ADMIN_PHONE;

    if (type === "new_order") {
      const items = Array.isArray(data.items)
        ? data.items.map(i => `• ${i.product_name} x${i.qty} = Rs ${i.total}`).join("\n")
        : "—";
      const trackLink = `${baseUrl}/track-order?order=${data.order_number}`;

      const adminMsg =
        `🛍️ *New Order - ${shopName}*\n\n` +
        `📦 Order: *${data.order_number}*\n` +
        `👤 ${data.customer_name}\n` +
        `📱 ${data.customer_phone}\n` +
        `🏙️ ${data.customer_city || "—"}\n` +
        `📍 ${data.customer_address || "—"}\n\n` +
        `${items}\n\n` +
        `💰 *Total: Rs ${parseFloat(data.grand_total || 0).toLocaleString()}*\n\n` +
        `🔗 ${trackLink}`;

      if (adminPhone) await sendMessage(adminPhone, adminMsg);

      if (data.customer_phone) {
        const custMsg =
          `✅ *Order Confirmed!*\n\n` +
          `Hi ${data.customer_name}! Your order has been placed.\n\n` +
          `📦 Order: *${data.order_number}*\n\n` +
          `${items}\n\n` +
          `💰 *Total: Rs ${parseFloat(data.grand_total || 0).toLocaleString()}*\n` +
          `💵 Payment: ${data.payment_mode || "Cash on Delivery"}\n\n` +
          `🔗 Track your order:\n${trackLink}\n\n` +
          `Thank you for shopping with ${shopName}! 🙏`;
        await sendMessage(data.customer_phone, custMsg);
      }

      return res.json({ success: true, notified: "admin+customer" });
    }

    if (type === "order_status") {
      const trackLink = `${baseUrl}/track-order?order=${data.order_number}`;
      const statusEmoji = {
        "Order Booked": "📋", "Confirmed": "✅", "Processing": "⚙️",
        "Order Dispatched": "🚚", "Out for Delivery": "🏃",
        "Order Delivered": "✅", "Cancelled": "❌", "Returned": "↩️",
      };
      const emoji = statusEmoji[data.new_status] || "📦";

      const adminMsg =
        `${emoji} *Order Status Updated*\n\n` +
        `📦 Order: *${data.order_number}*\n` +
        `👤 ${data.customer_name}\n` +
        `📱 ${data.customer_phone}\n` +
        `🔄 Status: *${data.new_status}*\n\n` +
        `🔗 ${trackLink}`;

      if (adminPhone) await sendMessage(adminPhone, adminMsg);

      if (data.customer_phone) {
        const custMsg =
          `${emoji} *Order Update - ${shopName}*\n\n` +
          `Hi ${data.customer_name}!\n\n` +
          `Your order *${data.order_number}* status:\n\n` +
          `🔄 *${data.new_status}*\n\n` +
          `🔗 Track: ${trackLink}`;
        await sendMessage(data.customer_phone, custMsg);
      }

      return res.json({ success: true, notified: "admin+customer" });
    }

    res.status(400).json({ error: "Unknown type: " + type });
  } catch (e) {
    console.error("Notification error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post("/disconnect", async (req, res) => {
  try {
    if (sock) await sock.logout();
    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    connectionStatus = "disconnected";
    qrData = null;
    setTimeout(connectWA, 1000);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok", wa: connectionStatus }));

io.on("connection", (socket) => {
  console.log("Socket client connected");
  socket.emit("status", connectionStatus);
  if (connectionStatus === "qr" && qrData) socket.emit("qr", qrData);
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`WhatsApp server running on port ${PORT}`);
  connectWA();
});
