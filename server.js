const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const cors = require('cors');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const ADMIN_PHONE = process.env.ADMIN_PHONE || ''; // e.g. 923001234567
const AUTH_DIR = './auth_info_baileys';

let sock = null;
let connectionStatus = 'disconnected'; // disconnected | connecting | qr | connected
let currentQR = null;

// ─── WhatsApp Message Templates ────────────────────────────
const TEMPLATES = {
    new_order: (data) => `🛍️ *New Order Received!*\n\n📦 Order: *${data.order_number}*\n👤 Customer: *${data.customer_name}*\n📱 Phone: ${data.customer_phone}\n📍 Address: ${data.customer_address}\n\n🛒 *Items:*\n${(data.items||[]).map(i=>`  • ${i.product_name} x${i.qty} = Rs ${i.total}`).join('\n')}\n\n💰 Total: *Rs ${data.grand_total}*\n💳 Payment: ${data.payment_mode}\n\n✅ _We'll confirm your order shortly!_`,
    
    customer_order: (data) => `🎉 *Thank you for your order, ${data.customer_name}!*\n\n📦 Order No: *${data.order_number}*\n\n🛒 *Your Items:*\n${(data.items||[]).map(i=>`  • ${i.product_name} x${i.qty}`).join('\n')}\n\n💰 Total: *Rs ${data.grand_total}*\n💳 Payment: ${data.payment_mode}\n\n🚚 We'll update you as your order progresses.\n\n_Sam's Cosmetic_ 💄`,
    
    order_status: (data) => {
        const icons = { 'Order Pending':'⏳', 'Order Dispatched':'🚚', 'Order Delivered':'✅', 'Cancelled':'❌' };
        const icon = icons[data.new_status] || '📦';
        return `${icon} *Order Update!*\n\nHi ${data.customer_name}!\n\nYour order *${data.order_number}* status:\n*${data.new_status}*\n\n${data.new_status==='Order Delivered'?'🎉 Thank you for shopping with us!\n_Sam\'s Cosmetic_ 💄':data.new_status==='Cancelled'?'😔 Sorry for the inconvenience. Contact us for help.':'_Sam\'s Cosmetic_ 💄'}`;
    }
};

// ─── Start WhatsApp Connection ──────────────────────────────
async function connectWhatsApp() {
    connectionStatus = 'connecting';
    io.emit('status', { status: connectionStatus });

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ["Sam's Cosmetic", "Chrome", "1.0.0"]
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            currentQR = await QRCode.toDataURL(qr);
            connectionStatus = 'qr';
            io.emit('qr', { qr: currentQR });
            io.emit('status', { status: 'qr' });
            console.log('QR Code generated - scan with WhatsApp');
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            connectionStatus = 'disconnected';
            currentQR = null;
            io.emit('status', { status: 'disconnected' });
            if (shouldReconnect) {
                console.log('Reconnecting...');
                setTimeout(connectWhatsApp, 3000);
            } else {
                console.log('Logged out. Delete auth folder to reconnect.');
                if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true });
            }
        }

        if (connection === 'open') {
            connectionStatus = 'connected';
            currentQR = null;
            io.emit('status', { status: 'connected', phone: sock.user?.id });
            console.log('✅ WhatsApp Connected!', sock.user?.id);
        }
    });
}

// ─── Send Message Helper ────────────────────────────────────
async function sendMessage(phone, message) {
    if (!sock || connectionStatus !== 'connected') {
        throw new Error('WhatsApp not connected');
    }
    const jid = phone.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
    await sock.sendMessage(jid, { text: message });
    return true;
}

// ─── API Routes ─────────────────────────────────────────────

// Status
app.get('/status', (req, res) => {
    res.json({ status: connectionStatus, qr: currentQR });
});

// Send notification (called by PHP backend)
app.post('/send-notification', async (req, res) => {
    const { type, data } = req.body;
    if (!data) return res.json({ success: false, error: 'No data' });

    try {
        const template = TEMPLATES[type];
        if (!template) return res.json({ success: false, error: 'Unknown type' });

        const message = template(data);
        const results = [];

        // Send to customer
        if (data.customer_phone) {
            try {
                await sendMessage(data.customer_phone, type === 'new_order' ? TEMPLATES.customer_order(data) : message);
                results.push({ to: 'customer', success: true });
            } catch(e) {
                results.push({ to: 'customer', success: false, error: e.message });
            }
        }

        // Send to admin (only for new orders)
        if (type === 'new_order' && ADMIN_PHONE) {
            try {
                await sendMessage(ADMIN_PHONE, message);
                results.push({ to: 'admin', success: true });
            } catch(e) {
                results.push({ to: 'admin', success: false, error: e.message });
            }
        }

        res.json({ success: true, results });
    } catch(e) {
        res.json({ success: false, error: e.message });
    }
});

// Manual send
app.post('/send', async (req, res) => {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: 'phone and message required' });
    try {
        await sendMessage(phone, message);
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Force reconnect / generate QR
app.get('/connect', (req, res) => {
    if (connectionStatus === 'connected') {
        return res.json({ status: 'already_connected' });
    }
    // Reset and reconnect
    if (sock) { try { sock.end(); } catch(e) {} sock = null; }
    connectionStatus = 'disconnected';
    currentQR = null;
    connectWhatsApp();
    res.json({ status: 'connecting', message: 'QR generating... check /status in 10 seconds' });
});

// Disconnect
app.post('/disconnect', (req, res) => {
    if (sock) { sock.logout(); sock = null; }
    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true });
    connectionStatus = 'disconnected';
    res.json({ success: true });
    connectWhatsApp();
});

// ─── Socket.IO ──────────────────────────────────────────────
io.on('connection', (socket) => {
    console.log('Dashboard connected');
    socket.emit('status', { status: connectionStatus });
    if (currentQR) socket.emit('qr', { qr: currentQR });
});

// ─── Start ──────────────────────────────────────────────────
httpServer.listen(PORT, () => {
    console.log(`🚀 SAMS WhatsApp Server running on port ${PORT}`);
    connectWhatsApp();
});
