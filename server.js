const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const cors = require('cors');
const pino = require('pino');
const fs = require('fs');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const ADMIN_PHONE = process.env.ADMIN_PHONE || '';
const AUTH_DIR = './auth_info_baileys';

let sock = null;
let connectionStatus = 'disconnected';
let currentQR = null;
let reconnectTimer = null;

const TEMPLATES = {
    new_order: (d) => `🛍️ *New Order!*\n\n📦 *${d.order_number}*\n👤 ${d.customer_name}\n📱 ${d.customer_phone}\n📍 ${d.customer_address}\n\n🛒 Items:\n${(d.items||[]).map(i=>`  • ${i.product_name} x${i.qty} = Rs ${i.total}`).join('\n')}\n\n💰 Total: *Rs ${d.grand_total}*\n💳 ${d.payment_mode}`,
    customer_order: (d) => `🎉 *Thank you ${d.customer_name}!*\n\n📦 Order: *${d.order_number}*\n\nItems:\n${(d.items||[]).map(i=>`  • ${i.product_name} x${i.qty}`).join('\n')}\n\n💰 Total: *Rs ${d.grand_total}*\n\n🚚 We'll update you soon!\n_Sam's Cosmetic_ 💄`,
    order_status: (d) => {
        const icons = {'Order Pending':'⏳','Order Dispatched':'🚚','Order Delivered':'✅','Cancelled':'❌'};
        return `${icons[d.new_status]||'📦'} *Order Update*\n\nHi ${d.customer_name}!\nOrder *${d.order_number}*:\n*${d.new_status}*\n\n_Sam's Cosmetic_ 💄`;
    }
};

async function connectWhatsApp() {
    try {
        connectionStatus = 'connecting';
        io.emit('status', { status: 'connecting' });
        console.log('🔄 Connecting to WhatsApp...');

        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

        // Use stable hardcoded version - no network fetch needed
        const version = [2, 3000, 1023333488];
        console.log('Using Baileys version:', version);

        sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'debug' }),
            printQRInTerminal: true,
            browser: ["SAMs", "Chrome", "120.0.0"],
            connectTimeoutMs: 60000,
            qrTimeout: 60000,
            defaultQueryTimeoutMs: 60000,
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            console.log('📡 Connection update:', JSON.stringify({ connection, hasQR: !!qr, status: connectionStatus }));

            if (qr) {
                console.log('📷 QR received! Generating image...');
                try {
                    currentQR = await QRCode.toDataURL(qr);
                    connectionStatus = 'qr';
                    io.emit('qr', { qr: currentQR });
                    io.emit('status', { status: 'qr' });
                    console.log('✅ QR ready!');
                } catch(e) {
                    console.error('QR error:', e.message);
                }
            }

            if (connection === 'close') {
                const code = lastDisconnect?.error?.output?.statusCode;
                const reason = lastDisconnect?.error?.message || 'unknown';
                console.log(`❌ Disconnected. Code: ${code}, Reason: ${reason}`);
                connectionStatus = 'disconnected';
                currentQR = null;
                io.emit('status', { status: 'disconnected' });

                if (code === DisconnectReason.loggedOut) {
                    console.log('Logged out - clearing auth');
                    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true });
                } else if (code !== 401) {
                    console.log('Reconnecting in 5s...');
                    if (reconnectTimer) clearTimeout(reconnectTimer);
                    reconnectTimer = setTimeout(connectWhatsApp, 5000);
                }
            }

            if (connection === 'open') {
                connectionStatus = 'connected';
                currentQR = null;
                console.log('✅ WhatsApp Connected!', sock?.user?.id);
                io.emit('status', { status: 'connected', phone: sock?.user?.id });
            }
        });

    } catch(e) {
        console.error('❌ connectWhatsApp error:', e.message);
        connectionStatus = 'disconnected';
        io.emit('status', { status: 'disconnected' });
        // Retry after 10s
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connectWhatsApp, 10000);
    }
}

async function sendMessage(phone, message) {
    if (!sock || connectionStatus !== 'connected') throw new Error('Not connected');
    const jid = phone.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
    await sock.sendMessage(jid, { text: message });
    return true;
}

// Routes
app.get('/status', (req, res) => {
    res.json({ status: connectionStatus, qr: currentQR, phone: sock?.user?.id || null });
});

app.get('/connect', (req, res) => {
    console.log('🔌 Manual connect triggered');
    if (sock) { try { sock.end(); } catch(e) {} sock = null; }
    if (reconnectTimer) clearTimeout(reconnectTimer);
    connectionStatus = 'disconnected';
    currentQR = null;
    connectWhatsApp();
    res.json({ status: 'connecting', message: 'Check /status in 15 seconds' });
});

app.post('/disconnect', (req, res) => {
    console.log('🔌 Disconnect triggered');
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (sock) { try { sock.logout(); } catch(e) {} sock = null; }
    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true });
    connectionStatus = 'disconnected';
    currentQR = null;
    io.emit('status', { status: 'disconnected' });
    res.json({ success: true });
    setTimeout(connectWhatsApp, 2000);
});

app.post('/send-notification', async (req, res) => {
    const { type, data } = req.body;
    if (!data) return res.json({ success: false, error: 'No data' });
    try {
        const template = TEMPLATES[type];
        if (!template) return res.json({ success: false, error: 'Unknown type' });
        const results = [];
        if (data.customer_phone) {
            try {
                const msg = type === 'new_order' ? TEMPLATES.customer_order(data) : template(data);
                await sendMessage(data.customer_phone, msg);
                results.push({ to: 'customer', success: true });
            } catch(e) { results.push({ to: 'customer', success: false, error: e.message }); }
        }
        if (type === 'new_order' && ADMIN_PHONE) {
            try { await sendMessage(ADMIN_PHONE, template(data)); results.push({ to: 'admin', success: true }); }
            catch(e) { results.push({ to: 'admin', success: false, error: e.message }); }
        }
        res.json({ success: true, results });
    } catch(e) { res.json({ success: false, error: e.message }); }
});

app.post('/send', async (req, res) => {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: 'phone and message required' });
    try { await sendMessage(phone, message); res.json({ success: true }); }
    catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

io.on('connection', (socket) => {
    console.log('📊 Dashboard connected');
    socket.emit('status', { status: connectionStatus });
    if (currentQR) socket.emit('qr', { qr: currentQR });
});

httpServer.listen(PORT, () => {
    console.log(`🚀 SAMs WhatsApp Server on port ${PORT}`);
    connectWhatsApp();
});
