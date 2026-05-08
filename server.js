import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import qrcode from 'qrcode';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

let sock = null;
let qrImageBase64 = null;
let status = 'disconnected'; // disconnected | connecting | qr | connected

const AUTH_FOLDER = './auth_info_baileys';

async function connectWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: true,
      browser: ['SAMs Salon', 'Chrome', '1.0.0'],
    });

    status = 'connecting';
    io.emit('status', { status });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        status = 'qr';
        qrImageBase64 = await qrcode.toDataURL(qr);
        io.emit('qr', { qr: qrImageBase64 });
        io.emit('status', { status: 'qr' });
        console.log('QR Code generated');
      }

      if (connection === 'close') {
        const shouldReconnect =
          (lastDisconnect?.error instanceof Boom)
            ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
            : true;

        console.log('Connection closed. Reconnect:', shouldReconnect);
        status = 'disconnected';
        qrImageBase64 = null;
        io.emit('status', { status: 'disconnected' });

        if (shouldReconnect) {
          setTimeout(connectWhatsApp, 3000);
        }
      }

      if (connection === 'open') {
        console.log('WhatsApp connected!');
        status = 'connected';
        qrImageBase64 = null;
        io.emit('status', { status: 'connected' });
      }
    });

    sock.ev.on('creds.update', saveCreds);

  } catch (err) {
    console.error('connectWhatsApp error:', err);
    status = 'disconnected';
    setTimeout(connectWhatsApp, 5000);
  }
}

// Routes
app.get('/status', (req, res) => {
  res.json({ status, qr: qrImageBase64 });
});

app.get('/connect', (req, res) => {
  if (status === 'disconnected') {
    connectWhatsApp();
    res.json({ message: 'Connecting...' });
  } else {
    res.json({ message: `Already ${status}` });
  }
});

app.post('/disconnect', async (req, res) => {
  if (sock) {
    await sock.logout();
    sock = null;
  }
  // Delete auth files so fresh QR shows
  if (fs.existsSync(AUTH_FOLDER)) {
    fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
  }
  status = 'disconnected';
  qrImageBase64 = null;
  io.emit('status', { status: 'disconnected' });
  res.json({ message: 'Disconnected' });
});

app.post('/send-message', async (req, res) => {
  const { phone, message } = req.body;
  if (!sock || status !== 'connected') {
    return res.status(503).json({ error: 'WhatsApp not connected' });
  }
  try {
    const jid = phone.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
    await sock.sendMessage(jid, { text: message });
    res.json({ success: true });
  } catch (err) {
    console.error('Send error:', err);
    res.status(500).json({ error: err.message });
  }
});

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  socket.emit('status', { status });
  if (qrImageBase64) {
    socket.emit('qr', { qr: qrImageBase64 });
  }
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`WhatsApp server running on port ${PORT}`);
  connectWhatsApp();
});
