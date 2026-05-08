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
let notificationSettings = null;

const AUTH_DIR = "./auth_info";
const PHP_BACKEND_URL = process.env.PHP_BACKEND_URL || "https://sams.g0vi.pk/api";

// Fetch settings from PHP backend
async function fetchSettings() {
  try {
    const response = await fetch(`${PHP_BACKEND_URL}/wa-settings.php`);
    if (response.ok) {
      notificationSettings = await response.json();
      console.log("✅ Settings loaded:", notificationSettings);
    }
  } catch (e) {
    console.error("Failed to fetch settings:", e.message);
  }
}

// Should admin be notified?
async function shouldNotifyAdmin(statusType, isNewOrder = false) {
  await fetchSettings(); // Fresh fetch every time
  if (isNewOrder) {
    return notificationSettings?.newOrder?.admin !== false;
  }
  return notificationSettings?.statusUpdates?.[statusType]?.admin !== false;
}

// Should customer be notified?
async function shouldNotifyCustomer(statusType, isNewOrder = false) {
  await fetchSettings();
  if (isNewOrder) {
    return notificationSettings?.newOrder?.customer !== false;
  }
  return notificationSettings?.statusUpdates?.[statusType]?.customer !== false;
}

// Get admin phone
async function getAdminPhone() {
  await fetchSettings();
  return notificationSettings?.adminPhone || process.env.ADMIN_PHONE || null;
}

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
      console.log("📱 QR code generated");
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
      console.log("✅ WhatsApp connected!");
      await fetchSettings();
    }
  });
}

async function sendMessage(phone, message) {
  if (!sock || connectionStatus !== "connected") {
    throw new Error("WhatsApp not connected");
  }
  let num = phone.replace(/\D/g, "");
  if (num.startsWith("0")) num = "92" + num.slice(1);
  if (!num.startsWith("92")) num = "92" + num;
  const jid = num + "@s.whatsapp.net";
  await sock.sendMessage(jid, { text: message });
  console.log(`✅ Message sent to ${jid}`);
}

app.get("/status", (req, res) => {
  if (connectionStatus === "qr" && qrData) {
    return res.json({ status: "qr", qr: qrData });
  }
  res.json({ status: connectionStatus });
});

app.post("/send", async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) {
    return res.status(400).json({ error: "phone and message required" });
  }
  try {
    await sendMessage(phone, message);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/send-notification", async (req, res) => {
  const { type, data } = req.body;
  if (!type || !data) {
    return res.status(400).json({ error: "type and data required" });
  }

  try {
    const shopName = process.env.SHOP_NAME || "Sam's Skin Care";
    const baseUrl = process.env.BASE_URL || "https://sams.g0vi.pk";

    // NEW ORDER
    if (type === "new_order") {
      const items = Array.isArray(data.items)
        ? data.items.map(i => `• ${i.product_name} x${i.qty} = Rs ${i.total}`).join("\n")
        : "—";
      const trackLink = `${baseUrl}/track-order?order=${data.order_number}`;

      const adminMsg = `🛍️ *NEW ORDER - ${shopName}*\n\n📦 Order: *${data.order_number}*\n👤 ${data.customer_name}\n📱 ${data.customer_phone}\n🏙️ ${data.customer_city || "—"}\n📍 ${data.customer_address || "—"}\n\n${items}\n\n💰 *Total: Rs ${parseFloat(data.grand_total || 0).toLocaleString()}*\n\n🔗 ${trackLink}`;

      const custMsg = `✅ *Order Confirmed!*\n\nHi ${data.customer_name}! Thank you for your order.\n\n📦 Order: *${data.order_number}*\n\n${items}\n\n💰 *Total: Rs ${parseFloat(data.grand_total || 0).toLocaleString()}*\n💵 Payment: ${data.payment_mode || "Cash on Delivery"}\n\n🔗 Track: ${trackLink}\n\nThank you for shopping with ${shopName}! 🙏`;

      let notified = [];

      // Admin notification (only if enabled)
      if (await shouldNotifyAdmin(null, true)) {
        const adminPhone = await getAdminPhone();
        if (adminPhone) {
          await sendMessage(adminPhone, adminMsg);
          notified.push("admin");
        }
      }

      // Customer notification (only if enabled)
      if (await shouldNotifyCustomer(null, true) && data.customer_phone) {
        await sendMessage(data.customer_phone, custMsg);
        notified.push("customer");
      }

      return res.json({ success: true, notified });
    }

    // ORDER STATUS UPDATE
    if (type === "order_status") {
      const trackLink = `${baseUrl}/track-order?order=${data.order_number}`;
      const statusEmoji = {
        "Order Booked": "📋", "Confirmed": "✅", "Processing": "⚙️",
        "Order Dispatched": "🚚", "Out for Delivery": "🏃",
        "Order Delivered": "✅", "Cancelled": "❌", "Returned": "↩️",
      };
      const emoji = statusEmoji[data.new_status] || "📦";

      const adminMsg = `${emoji} *Order Status Update*\n\n📦 Order: *${data.order_number}*\n👤 ${data.customer_name}\n📱 ${data.customer_phone}\n🔄 Status: *${data.new_status}*\n\n🔗 ${trackLink}`;

      const custMsg = `${emoji} *Order Update - ${shopName}*\n\nHi ${data.customer_name}! Your order status has been updated.\n\n📦 Order: *${data.order_number}*\n🔄 *${data.new_status}*\n\n🔗 Track: ${trackLink}`;

      let notified = [];

      // Admin notification for status updates (ONLY if enabled in settings)
      // By default, admin only gets NEW ORDER, not status updates
      if (await shouldNotifyAdmin(data.new_status, false)) {
        const adminPhone = await getAdminPhone();
        if (adminPhone) {
          await sendMessage(adminPhone, adminMsg);
          notified.push("admin");
        }
      }

      // Customer notification (if enabled)
      if (await shouldNotifyCustomer(data.new_status, false) && data.customer_phone) {
        await sendMessage(data.customer_phone, custMsg);
        notified.push("customer");
      }

      return res.json({ success: true, notified });
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
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    }
    connectionStatus = "disconnected";
    qrData = null;
    setTimeout(connectWA, 1000);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", wa: connectionStatus });
});

io.on("connection", (socket) => {
  console.log("Socket client connected");
  socket.emit("status", connectionStatus);
  if (connectionStatus === "qr" && qrData) {
    socket.emit("qr", qrData);
  }
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`🚀 WhatsApp server running on port ${PORT}`);
  connectWA();
});
