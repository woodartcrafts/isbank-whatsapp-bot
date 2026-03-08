require('dotenv').config();
const { ImapFlow } = require('imapflow');
const pdf = require('pdf-parse');
const cron = require('node-cron');
const fetch = require('node-fetch');

// ─────────────────────────────────────────
// İşlenmiş email ID'leri (aynı emaili iki kez gönderme)
// Railway'de dosya sistemi geçici olduğundan memory'de tutuyoruz
// ─────────────────────────────────────────
const processedIds = new Set();
const DEFAULT_ISBANK_SENDER = 'bilgilendirme@ileti.isbank.com.tr';

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Eksik ortam degiskeni: ${name}`);
  }
  return value.trim();
}

function formatAmountForMessage(amountWithSign) {
  // amountWithSign degeri zaten + veya - ile gelir.
  return `${amountWithSign} TRY`;
}

function cleanDescription(raw) {
  return raw
    .replace(/\bŞube\s*\d+\b/gi, ' ')
    .replace(/\*\d{4,}\*/g, ' ')
    .replace(/\*FAST\b/gi, ' ')
    .replace(/\bFAST\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isMeaningfulDescription(text) {
  const value = String(text || '').trim();
  if (!value) return false;

  // Suba kodu gibi anlamsiz alanlari aciklama olarak kabul etme.
  if (/^sube\s*\d+$/i.test(value)) return false;
  if (/^[*\-\s\d]+$/.test(value)) return false;

  return value.length >= 4;
}

function isTrue(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

function isExpectedStatementSubject(subject) {
  if (!subject) return false;
  return /\btarihli\b/i.test(subject) && /hesap\s+ozeti|hesap\s+özeti/i.test(subject);
}

function isNoStatementEmailBody(sourceText) {
  return /hesap\s+ozeti\s+uretilmemistir|hesap\s+özeti\s+üretilmemiştir/i.test(sourceText);
}

function isExpectedSender(envelopeFromAddress, envelopeFromName, senderFilter) {
  const expected = String(senderFilter || '').trim().toLowerCase();
  const addr = String(envelopeFromAddress || '').trim().toLowerCase();
  const name = String(envelopeFromName || '').trim().toLowerCase();

  if (!expected) return true;

  // Tam e-posta adresi verilmis ise birebir dogrula.
  if (expected.includes('@')) {
    return addr === expected;
  }

  // Anahtar kelime verilmis ise adreste veya gonderen adinda gecmesini kabul et.
  return addr.includes(expected) || name.includes(expected);
}

function findPdfPart(node) {
  if (!node) return null;
  const filename = String(node.dispositionParameters?.filename || node.parameters?.name || '').toLowerCase();
  const isPdfByType = (node.type === 'application' && node.subtype === 'pdf');
  const isPdfByName = filename.endsWith('.pdf');

  if (node.part && (isPdfByType || isPdfByName)) return node.part;

  if (Array.isArray(node.childNodes)) {
    for (const child of node.childNodes) {
      const found = findPdfPart(child);
      if (found) return found;
    }
  }

  return null;
}

// ─────────────────────────────────────────
// WhatsApp grubuna Green API ile mesaj gönder
// ─────────────────────────────────────────
async function sendWhatsApp(message) {
  const instance = requireEnv('GREENAPI_INSTANCE');
  const token = requireEnv('GREENAPI_TOKEN');
  const groupId = requireEnv('WHATSAPP_GROUP_ID');

  const url = `https://api.green-api.com/waInstance${instance}/sendMessage/${token}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: groupId, message })
  });

  const result = await response.json();

  if (result.idMessage) {
    console.log('✅ WhatsApp mesajı gönderildi. ID:', result.idMessage);
  } else {
    console.error('❌ WhatsApp gönderilemedi:', JSON.stringify(result));
  }
}

// ─────────────────────────────────────────
// PDF'ten gelen işlemleri çıkar
// ─────────────────────────────────────────
async function parseIsbankPdf(buffer) {
  const data = await pdf(buffer);
  const text = data.text;
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  const transactions = [];
  const dateRegex = /^(\d{2}\.\d{2}\.\d{4})\s+\d{2}:\d{2}:\d{2}/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const dateMatch = line.match(dateRegex);
    if (!dateMatch) continue;

    const date = dateMatch[1];

    // Tutarları bul (+/- TRY)
    const amounts = [...line.matchAll(/([+-][\d.]+,\d{2})\s*TRY/g)];
    if (amounts.length < 1) continue;

    // İlk tutar = işlem tutarı, ikincisi = bakiye
    const amountStr = amounts[0][1];
    const numericVal = parseFloat(amountStr.replace(/\./g, '').replace(',', '.'));

    // Sadece pozitif (gelen) işlemler
    if (numericVal <= 0) continue;

    // Aciklamayi kolon bazli al: ikinci tutardan (bakiye) sonraki kisim.
    const secondAmount = amounts[1] || amounts[0];
    const amountWithTry = secondAmount[0];
    const amountStart = secondAmount.index || 0;
    const descStart = amountStart + amountWithTry.length;

    let desc = line.slice(descStart).trim();

    // Bazi PDF'lerde TRY ile aciklama birlesik gelebiliyor.
    if (!desc && amounts[0]?.index !== undefined) {
      const firstAmountStart = amounts[0].index;
      const firstAmountEnd = firstAmountStart + amounts[0][0].length;
      desc = line.slice(firstAmountEnd).trim();
    }

    // Bazi satirlarda bakiye metni aciklamanin basina kayabiliyor, temizle.
    desc = desc.replace(/^[+-][\d.]+,\d{2}\s*TRY\s*/i, '').trim();

    // Teknik kodlar ve sube kalintilarini temizle.
    desc = cleanDescription(desc);

    // Aciklama anlamsizsa sonraki satirlardan anlamli bir metin bul.
    if (!isMeaningfulDescription(desc)) {
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const next = lines[j];
        if (next.match(dateRegex)) break;

        const nextClean = cleanDescription(next);
        if (isMeaningfulDescription(nextClean)) {
          desc = `${desc} ${nextClean}`.trim();
          break;
        }
      }
    }

    if (!isMeaningfulDescription(desc)) {
      desc = 'Aciklama bulunamadi';
    }

    transactions.push({ date, amount: amountStr, description: desc });
  }

  return transactions;
}

// ─────────────────────────────────────────
// Gmail'den PDF'li emaili bul ve işle
// ─────────────────────────────────────────
async function checkEmails() {
  const now = new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
  console.log(`\n🔍 [${now}] Gmail kontrol ediliyor...`);

  let client;

  try {
    client = new ImapFlow({
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      auth: {
        user: requireEnv('GMAIL_USER'),
        pass: requireEnv('GMAIL_APP_PASSWORD')
      },
      logger: false
    });

    await client.connect();
    await client.mailboxOpen('INBOX');

    // Son 2 günün emaillerini tara
    const oneOffReplayEnabled = isTrue(process.env.ONE_OFF_REPLAY_ENABLED);
    const oneOffReplayDate = String(process.env.ONE_OFF_REPLAY_DATE || '').trim();
    const senderFilter = (process.env.ISBANK_EMAIL_ADDRESS || process.env.ISBANK_EMAIL_FROM || DEFAULT_ISBANK_SENDER).trim();
    const sinceDate = oneOffReplayEnabled
      ? new Date(Date.now() - 45 * 24 * 60 * 60 * 1000)
      : new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

    if (oneOffReplayEnabled) {
      if (!oneOffReplayDate) {
        console.log('⚠️  ONE_OFF_REPLAY_ENABLED=true ama ONE_OFF_REPLAY_DATE bos. One-off modu atlandi.');
      } else {
        console.log(`🧪 One-off replay modu aktif. Hedef tarih: ${oneOffReplayDate}`);
      }
    }

    const uids = await client.search({
      from: senderFilter,
      since: sinceDate
    });

    console.log(`📬 ${uids.length} İş Bankası emaili bulundu.`);

    if (uids.length === 0) {
      await client.logout();
      console.log('✅ Kontrol tamamlandı.\n');
      return;
    }

    const sortedUidsDesc = [...uids].sort((a, b) => b - a);
    let candidateUids = sortedUidsDesc;

    if (!oneOffReplayEnabled) {
      // Normal mod: sadece en son email.
      candidateUids = [sortedUidsDesc[0]];
      console.log(`🆕 En son email UID: ${candidateUids[0]}`);
    }

    let oneOffSent = false;

    for (const uid of candidateUids) {
      if (!oneOffReplayEnabled && processedIds.has(String(uid))) {
        console.log(`⏭️  UID ${uid} zaten işlendi.`);
        continue;
      }

      // Email kaynağını indir
      const msg = await client.fetchOne(uid, {
        envelope: true,
        bodyStructure: true,
        source: true
      });

      const source = msg.source.toString('utf8');
      const envelopeFromAddress = String(msg.envelope?.from?.[0]?.address || '').toLowerCase();
      const envelopeFromName = String(msg.envelope?.from?.[0]?.name || '').toLowerCase();
      const expectedSender = senderFilter.toLowerCase();
      const subject = String(msg.envelope?.subject || '');

      if (oneOffReplayEnabled && oneOffReplayDate) {
        const hasTargetDate = subject.includes(oneOffReplayDate) || source.includes(oneOffReplayDate);
        if (!hasTargetDate) {
          continue;
        }
      }

      if (!isExpectedSender(envelopeFromAddress, envelopeFromName, senderFilter)) {
        console.log(`⏭️  UID ${uid}: beklenen gonderici degil (beklenen: ${expectedSender}, gelen: ${envelopeFromAddress}), atlandi.`);
        processedIds.add(String(uid));
        continue;
      }

      if (!isExpectedStatementSubject(subject)) {
        console.log(`⏭️  UID ${uid}: hesap ozeti konu formati degil, atlandi.`);
        processedIds.add(String(uid));
        continue;
      }

      if (isNoStatementEmailBody(source)) {
        console.log(`ℹ️  UID ${uid}: gun icinde hareket yok, hesap ozeti uretilmemis.`);
        processedIds.add(String(uid));
        continue;
      }

      // Email tarihini al
      let emailDate = new Date().toLocaleDateString('tr-TR', { timeZone: 'Europe/Istanbul' });
      const dateHeader = source.match(/^Date:\s*(.+)$/m);
      if (dateHeader) {
        try { emailDate = new Date(dateHeader[1].trim()).toLocaleDateString('tr-TR'); } catch {}
      }

      // MIME yapisindan PDF ekini bulup dogrudan indir
      let pdfBuffer = null;
      const pdfPart = findPdfPart(msg.bodyStructure);

      if (pdfPart) {
        const { content } = await client.download(uid, pdfPart);
        const chunks = [];
        for await (const chunk of content) chunks.push(chunk);
        const candidate = Buffer.concat(chunks);
        if (candidate.slice(0, 4).toString() === '%PDF') {
          pdfBuffer = candidate;
        }
      }

      // Fallback: Bazi MIME varyasyonlarinda source'tan base64 yakalamayi dene.
      if (!pdfBuffer) {
        const base64Blocks = [...source.matchAll(/Content-Transfer-Encoding:\s*base64\r?\n\r?\n([\s\S]+?)(?=\r?\n--|\r?\n\r?\nContent-)/gi)];

        for (const block of base64Blocks) {
          try {
            const raw = block[1].replace(/\s/g, '');
            const buf = Buffer.from(raw, 'base64');
            if (buf.slice(0, 4).toString() === '%PDF') {
              pdfBuffer = buf;
              break;
            }
          } catch {}
        }
      }

      if (!pdfBuffer) {
        console.log(`⚠️  UID ${uid}: PDF bulunamadı, atlanıyor.`);
        processedIds.add(String(uid));
        continue;
      }

      console.log(`📄 UID ${uid}: PDF parse ediliyor...`);
      const transactions = await parseIsbankPdf(pdfBuffer);

      if (transactions.length === 0) {
        console.log(`ℹ️  UID ${uid}: Gelen işlem yok.`);
        processedIds.add(String(uid));
        continue;
      }

      console.log(`💰 ${transactions.length} gelen işlem:`);
      transactions.forEach(t => console.log(`   ${t.date} | ${formatAmountForMessage(t.amount)} | ${t.description}`));

      // Mesaj oluştur
      let msg2 = `🏦 *İş Bankası Hesap Hareketi*\n`;
      msg2 += `📅 ${emailDate}\n`;
      msg2 += `─────────────────\n`;

      for (const tx of transactions) {
        msg2 += `\n📥 *${formatAmountForMessage(tx.amount)}*\n`;
        msg2 += `📆 ${tx.date}\n`;
        msg2 += `📝 ${tx.description}\n`;
        msg2 += `──────────────\n`;
      }

      await sendWhatsApp(msg2);
      processedIds.add(String(uid));

      if (oneOffReplayEnabled) {
        oneOffSent = true;
        console.log(`✅ One-off replay basarili. UID ${uid} gonderildi.`);
        break;
      }
    }

    if (oneOffReplayEnabled && oneOffReplayDate && !oneOffSent) {
      console.log(`ℹ️  One-off replay icin ${oneOffReplayDate} tarihli uygun email bulunamadi.`);
    }

    await client.logout();
    console.log('✅ Kontrol tamamlandı.\n');

  } catch (err) {
    console.error('❌ Hata:', err.message);
    if (client) {
      try { await client.logout(); } catch {}
    }
  }
}

// ─────────────────────────────────────────
// Başlat
// ─────────────────────────────────────────
console.log(`🚀 Bot başladı. Her gün saat 12:00'de Gmail kontrol edilecek.`);

// Europe/Istanbul timezone ile direkt 12:00 cron kullan.
cron.schedule('0 12 * * *', () => {
  checkEmails().catch((err) => {
    console.error('❌ Zamanlanmis gorev hatasi:', err.message);
  });
}, {
  timezone: 'Europe/Istanbul'
});

// Railway restart sonrasinda gunu kacirmamak icin acilista bir kez de kontrol et.
checkEmails().catch((err) => {
  console.error('❌ Acilis kontrol hatasi:', err.message);
});
