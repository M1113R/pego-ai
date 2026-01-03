import makeWASocket, { useMultiFileAuthState, downloadContentFromMessage, DisconnectReason, getContentType } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import sharp from 'sharp';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from '@ffmpeg-installer/ffmpeg';
import os from 'os';
import fs from 'fs';
import path from 'path';
import util from 'util';

// Ensure fluent-ffmpeg uses the packaged ffmpeg binary (if available)
if (ffmpegPath && ffmpegPath.path) ffmpeg.setFfmpegPath(ffmpegPath.path);

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth');

  const sock = makeWASocket({
    auth: state,
    browser: ['WhatsApp Bot', 'Windows', '20'],
  });

  sock.ev.on('creds.update', saveCreds);

  let restarting = false;
  const pending = new Map(); // key -> timeout handle

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrcode.generate(qr, { small: true });
      console.log('QR code gerado. Escaneie com o WhatsApp');
    }

    if (connection === 'open') {
      console.log('✅ Conectado e pronto.');
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log('Conexão fechada', code ?? '', lastDisconnect?.error?.toString?.() ?? '');

      if (code === DisconnectReason.loggedOut) {
        console.log('Sessão deslogada. Remova ./auth e reinicie para relogar.');
        process.exit(0);
      }

      if (!restarting) {
        restarting = true;
        console.log('Reiniciando em 5s...');
        setTimeout(async () => {
          restarting = false;
          console.log('Tentando reconectar...');
          try {
            await start();
          } catch (e) {
            console.error('Falha ao reiniciar:', e);
            process.exit(1);
          }
        }, 5000);
      }
    }
  });

  sock.ev.on('messages.upsert', async (upsert) => {
    try {
      const messages = upsert.messages ?? [upsert];
      console.log(`📥 messages.upsert type=${upsert.type ?? 'unknown'} count=${messages.length}`);

      for (const m of messages) {
        const key = `${m.key?.remoteJid ?? 'unknown'}|${m.key?.id ?? 'noid'}`;

        if (!m.message) {
          if (!pending.has(key)) {
            console.log(`⚠️ Message without content, buffering for retry: ${key}`);
            const t = setTimeout(() => {
              console.log(`⌛ Pending message expired: ${key}`);
              pending.delete(key);
            }, 8000);
            pending.set(key, t);
          } else {
            console.log(`⚠️ Message without content, already pending: ${key}`);
          }
          continue;
        }

        if (pending.has(key)) {
          clearTimeout(pending.get(key));
          pending.delete(key);
          console.log(`🔁 Pending message now has content, processing: ${key}`);
        }

        if (m.key?.fromMe) { /* ignore messages from the bot itself */ continue; }
        if (m.key.remoteJid === 'status@broadcast') { continue; }

        // Unwrap ephemeral wrapper first, then view-once inner message when present
        const outer = m.message;
        const msg = outer.ephemeralMessage?.message ?? outer;
        const inner = msg.viewOnceMessage?.message ?? msg; // prefer the view-once inner payload if present
        const type = getContentType(msg);
        console.log(`ℹ️ From=${m.key.remoteJid} id=${m.key.id} type=${type} innerType=${getContentType(inner)}`);

        // Support imageMessage and videoMessage from inner (handles view-once properly)
        const imageMsg = inner.imageMessage ?? inner.viewOnceMessage?.message?.imageMessage;
        const videoMsg = inner.videoMessage ?? inner.viewOnceMessage?.message?.videoMessage;
        const caption = (imageMsg?.caption) || (videoMsg?.caption) || inner.extendedTextMessage?.text || '';
        if (msg.viewOnceMessage) console.log('🔒 Mensagem view-once detectada');

        // Keyword detection (case-insensitive)
        const text = inner.conversation ?? inner.extendedTextMessage?.text ?? msg.conversation ?? '';
        if (typeof text === 'string') {
          // If message contains 'porta' AND both 'confirma' and 'para', send the ignoring notice
          if (/porta/i.test(text) && /confirma/i.test(text) && /para/i.test(text)) {
            console.log(`🔎 Mensagem de confirmação detectada em ${m.key.remoteJid}: ${text}`);
            try {
              // await sock.sendMessage(m.key.remoteJid, { text: "eh apenas uma mensagem de confirmacao, ignorar" }, { quoted: m });
            } catch (e) {
              console.log('Erro ao responder por confirmation keyword:', e);
            }
          } else if (/porta/i.test(text)) {
            console.log(`🔎 Palavra 'porta' detectada em ${m.key.remoteJid}: ${text}`);
            try {
              await sock.sendMessage(m.key.remoteJid, { text: "pego" }, { quoted: m });
            } catch (e) {
              console.log('Erro ao responder por keyword:', e);
            }
          }
        }

        // Debug: if caption requests sticker but no media found, dump message structure (short)
        if (typeof caption === 'string' && caption.includes('#s') && !imageMsg && !videoMsg) {
          console.log('⚠️ Recebido #s mas sem imagem/vídeo detectado — exibindo estrutura resumida para diagnóstico');
          try {
            const dump = util.inspect({ outer: outer, msg: msg, inner: inner }, { depth: 4, colors: false, maxArrayLength: 50 });
            console.log(dump);
          } catch (e) {
            console.log('Erro ao inspecionar mensagem:', e);
          }
          continue;
        }

        // Case 1: static image -> sharp -> webp
        if (imageMsg && (!imageMsg.mimetype || imageMsg.mimetype !== 'image/gif')) {
          if (typeof caption !== 'string' || !caption.includes('#s')) { console.log('— Legenda sem #s:', caption); continue; }

          const jid = m.key.remoteJid;
          console.log('⬇️ Downloading image...');
          const stream = await downloadContentFromMessage(imageMsg, 'image');
          let buffer = Buffer.from([]);
          for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
          console.log(`⬇️ Download concluído: ${buffer.length} bytes`);

          const webp = await sharp(buffer)
            .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .webp({ lossless: true })
            .toBuffer();

          await sock.sendMessage(jid, { sticker: webp }, { quoted: m });
          console.log('✅ Sticker enviado (imagem estática)');
          continue;
        }

        // Case 2: GIF (image/gif) or animated video (gifPlayback) -> use ffmpeg to generate animated webp
        const isGif = (imageMsg && imageMsg.mimetype === 'image/gif') || (videoMsg && videoMsg.gifPlayback);
        if (isGif || videoMsg) {
          if (typeof caption !== 'string' || !caption.includes('#s')) { console.log('— Legenda sem #s:', caption); continue; }

          // Require ffmpeg binary available
          if (!ffmpegPath || !ffmpegPath.path) {
            console.log('⚠️ ffmpeg não encontrado. Instale @ffmpeg-installer/ffmpeg and fluent-ffmpeg');
            continue;
          }

          const media = videoMsg ?? imageMsg;
          const mediaType = videoMsg ? 'video' : 'image';
          const jid = m.key.remoteJid;

          console.log(`⬇️ Downloading ${mediaType} (animated)...`);
          const stream = await downloadContentFromMessage(media, mediaType);
          const inputPath = path.join(os.tmpdir(), `wa-input-${Date.now()}.${mediaType === 'video' ? 'mp4' : 'gif'}`);
          const outputPath = path.join(os.tmpdir(), `wa-output-${Date.now()}.webp`);

          // save to temp file
          const writeStream = fs.createWriteStream(inputPath);
          for await (const chunk of stream) writeStream.write(chunk);
          await new Promise((res) => writeStream.end(res));

          console.log('🔁 Converting to animated WebP via ffmpeg...');

          await new Promise((resolve, reject) => {
            ffmpeg(inputPath)
              .outputOptions([
                '-vcodec', 'libwebp',
                '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:-1:-1:color=#00000000',
                '-lossless', '1',
                '-loop', '0',
                '-preset', 'default',
                '-an',
                '-vsync', '0',
                '-s', '512:512'
              ])
              .toFormat('webp')
              .save(outputPath)
              .on('end', resolve)
              .on('error', (err) => reject(err));
          });

          const webpBuffer = await fs.promises.readFile(outputPath);

          await sock.sendMessage(jid, { sticker: webpBuffer }, { quoted: m });
          console.log('✅ Sticker enviado (animado)');

          // cleanup
          try { await fs.promises.unlink(inputPath); } catch (e) { /* ignore */ }
          try { await fs.promises.unlink(outputPath); } catch (e) { /* ignore */ }

          continue;
        }

        console.log('— Mensagem não é imagem/vídeo aceitável para sticker');
      }
    } catch (err) {
      console.error('Erro ao processar mensagem:', err);
    }
  });

  process.stdin.resume();
}

start().catch(err => {
  console.error('Falha ao iniciar:', err);
  process.exit(1);
});