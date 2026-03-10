require('dotenv').config();
const { ImapFlow } = require('imapflow');
const pdf = require('pdf-parse');
const cron = require('node-cron');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────
// Islenmis email UID'leri (ayni emaili iki kez gondermeme)
// Runtime acilisinda dosyadan yuklenir, her yeni UID'de tekrar kaydedilir.
// ─────────────────────────────────────────
const processedIds = new Set();
const processedIdQueue = [];
const DEFAULT_ISBANK_SENDER = 'bilgilendirme@ileti.isbank.com.tr';
const PROCESSED_IDS_FILE = path.resolve(process.cwd(), process.env.PROCESSED_IDS_FILE || 'processed-ids.json');
const maxProcessedIds = Number.parseInt(process.env.PROCESSED_IDS_MAX || '1000', 10);
const PROCESSED_IDS_MAX = Number.isFinite(maxProcessedIds) && maxProcessedIds > 0 ? maxProcessedIds : 1000;

function persistProcessedIds() {
  try {
    const payload = {
      ids: processedIdQueue,
      updatedAt: new Date().toISOString()
    };
    fs.writeFileSync(PROCESSED_IDS_FILE, JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    console.error(`⚠️  Islenen UID dosyasi yazilamadi (${PROCESSED_IDS_FILE}):`, err.message);
  }
}

function loadProcessedIds() {
  try {
    if (!fs.existsSync(PROCESSED_IDS_FILE)) return;

    const raw = fs.readFileSync(PROCESSED_IDS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const ids = Array.isArray(parsed?.ids) ? parsed.ids : [];

    for (const id of ids) {
      const normalized = String(id || '').trim();
      if (!normalized || processedIds.has(normalized)) continue;
      processedIds.add(normalized);
      processedIdQueue.push(normalized);
    }

    while (processedIdQueue.length > PROCESSED_IDS_MAX) {
      const removed = processedIdQueue.shift();
      if (removed) processedIds.delete(removed);
    }

    console.log(`🧠 ${processedIdQueue.length} adet islenmis UID dosyadan yuklendi.`);
  } catch (err) {
    console.error(`⚠️  Islenen UID dosyasi okunamadi (${PROCESSED_IDS_FILE}):`, err.message);
  }
}

function markProcessed(uid) {
  const normalized = String(uid || '').trim();
  if (!normalized || processedIds.has(normalized)) return;

  processedIds.add(normalized);
  processedIdQueue.push(normalized);

  while (processedIdQueue.length > PROCESSED_IDS_MAX) {
    const removed = processedIdQueue.shift();
    if (removed) processedIds.delete(removed);
  }

  persistProcessedIds();
}

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
    .replace(/\*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isMeaningfulDescription(text) {
  const value = String(text || '').trim();
  if (!value) return false;

  // Suba kodu gibi anlamsiz alanlari aciklama olarak kabul etme.
  if (/^sube\s*\d+$/i.test(value)) return false;
  if (/^[*\-\s]+$/.test(value)) return false;

  return value.length >= 2;
}

function looksLikeContinuationLine(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  if (/^\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}:\d{2}/.test(value)) return false;
  if (/([+-][\d.]+,\d{2})\s*TRY/i.test(value)) return false;
  if (/^hesap\s+ozeti$/i.test(value)) return false;
  return true;
}

function normalizeForMatch(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function isStatementFooterLine(text) {
  const value = normalizeForMatch(String(text || '').trim());
  if (!value) return false;

  return (
    value.includes('islem saatleri turkiye saati ile gosterilmektedir') ||
    value.includes('bu hesap ozeti') ||
    value.includes('bizi tercih ettiginiz') ||
    value.includes('www.isbank.com.tr')
  );
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

function extractDateFromSubject(subject) {
  const match = String(subject || '').match(/(\d{2}\.\d{2}\.\d{4})/);
  return match ? match[1] : null;
}

function dateTextToSortableKey(dateText) {
  const m = String(dateText || '').trim().match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return null;

  const day = Number.parseInt(m[1], 10);
  const month = Number.parseInt(m[2], 10);
  const year = Number.parseInt(m[3], 10);
  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())) return null;

  return Number(`${m[3]}${m[2]}${m[1]}`);
}

function parseDateText(dateText) {
  const m = String(dateText || '').trim().match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return null;

  const day = Number.parseInt(m[1], 10);
  const month = Number.parseInt(m[2], 10);
  const year = Number.parseInt(m[3], 10);
  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())) return null;

  return date;
}

function diffInDays(a, b) {
  const msPerDay = 24 * 60 * 60 * 1000;
  const aUtc = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const bUtc = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.floor((aUtc - bUtc) / msPerDay);
}

function formatDateWithWeekday(dateText) {
  const value = String(dateText || '').trim();
  const m = value.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return value;

  const day = Number.parseInt(m[1], 10);
  const month = Number.parseInt(m[2], 10);
  const year = Number.parseInt(m[3], 10);
  const date = new Date(year, month - 1, day);

  if (Number.isNaN(date.getTime())) return value;
  const weekday = date.toLocaleDateString('tr-TR', { weekday: 'long', timeZone: 'Europe/Istanbul' });
  const weekdayCapitalized = weekday.charAt(0).toUpperCase() + weekday.slice(1);
  return `${value} ${weekdayCapitalized}`;
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

    // Aciklama kolonunun devam satirlarini topla (islem satiri/dipnot gelene kadar).
    const continuationParts = [];
    for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
      const next = lines[j];
      if (next.match(dateRegex)) break;

      const nextClean = cleanDescription(next);
      if (isStatementFooterLine(nextClean)) break;
      if (!looksLikeContinuationLine(nextClean)) continue;
      if (!isMeaningfulDescription(nextClean)) continue;

      continuationParts.push(nextClean);
    }

    const allParts = [];
    if (isMeaningfulDescription(desc) && !isStatementFooterLine(desc)) {
      allParts.push(desc);
    }
    allParts.push(...continuationParts);
    desc = allParts.join(' ').replace(/\s+/g, ' ').trim();

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

  // Runtime tanisi: Railway'de hangi instance ve hangi env degerleriyle calistigini net gosterir.
  const oneOffEnabledRaw = process.env.ONE_OFF_REPLAY_ENABLED;
  const oneOffDateRaw = process.env.ONE_OFF_REPLAY_DATE;
  const oneOffForceRaw = process.env.ONE_OFF_REPLAY_FORCE;
  const oneOffMaxAgeRaw = process.env.ONE_OFF_REPLAY_MAX_AGE_DAYS;
  const railService = process.env.RAILWAY_SERVICE_NAME || 'local';
  const railEnv = process.env.RAILWAY_ENVIRONMENT_NAME || 'local';
  const railDeploy = process.env.RAILWAY_DEPLOYMENT_ID || 'unknown';

  console.log(`🧭 Runtime: service=${railService}, env=${railEnv}, deploy=${railDeploy}`);
  console.log(`🧪 ONE_OFF raw: enabled=${oneOffEnabledRaw ?? '<undefined>'}, date=${oneOffDateRaw ?? '<undefined>'}, force=${oneOffForceRaw ?? '<undefined>'}, maxAge=${oneOffMaxAgeRaw ?? '<undefined>'}`);

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
    let oneOffReplayEnabled = isTrue(process.env.ONE_OFF_REPLAY_ENABLED);
    const oneOffReplayForce = isTrue(process.env.ONE_OFF_REPLAY_FORCE);
    const oneOffReplayDate = String(process.env.ONE_OFF_REPLAY_DATE || '').trim();
    const oneOffReplayMaxAgeRaw = Number.parseInt(process.env.ONE_OFF_REPLAY_MAX_AGE_DAYS || '1', 10);
    const oneOffReplayMaxAgeDays = Number.isFinite(oneOffReplayMaxAgeRaw) && oneOffReplayMaxAgeRaw >= 0
      ? oneOffReplayMaxAgeRaw
      : 1;

    if (oneOffReplayEnabled && oneOffReplayDate && !oneOffReplayForce) {
      const todayText = new Date().toLocaleDateString('tr-TR', { timeZone: 'Europe/Istanbul' });
      const todayDate = parseDateText(todayText);
      const replayDate = parseDateText(oneOffReplayDate);

      if (!replayDate) {
        console.log('⚠️  ONE_OFF_REPLAY_DATE gecersiz formatta. One-off modu devre disi birakildi.');
        oneOffReplayEnabled = false;
      } else if (todayDate) {
        const ageDays = diffInDays(todayDate, replayDate);
        if (ageDays > oneOffReplayMaxAgeDays) {
          console.log(`⚠️  ONE_OFF_REPLAY_DATE (${oneOffReplayDate}) ${ageDays} gun onceye ait. ONE_OFF_REPLAY_FORCE=true olmadigi icin one-off modu devre disi birakildi.`);
          oneOffReplayEnabled = false;
        }
      }
    }

    const senderFilter = (process.env.ISBANK_EMAIL_ADDRESS || process.env.ISBANK_EMAIL_FROM || DEFAULT_ISBANK_SENDER).trim();
    const sinceDate = oneOffReplayEnabled
      ? new Date(Date.now() - 45 * 24 * 60 * 60 * 1000)
      : new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

    if (oneOffReplayEnabled) {
      if (!oneOffReplayDate) {
        console.log('⚠️  ONE_OFF_REPLAY_ENABLED=true ama ONE_OFF_REPLAY_DATE bos. One-off modu atlandi.');
      } else {
        console.log(`🧪 One-off replay modu aktif. Hedef tarih: ${oneOffReplayDate}`);
        if (oneOffReplayForce) {
          console.log('⚠️  ONE_OFF_REPLAY_FORCE=true oldugu icin daha once islenmis UID tekrar gonderilebilir.');
        }
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
      // Normal mod: konu satirindaki ozet tarihi en yeni olan UID'i sec.
      let selectedUid = sortedUidsDesc[0];
      let selectedDateKey = null;
      let selectedDateText = null;

      for (const uid of sortedUidsDesc) {
        const info = await client.fetchOne(uid, { envelope: true });
        const subjectDateText = extractDateFromSubject(info?.envelope?.subject || '');
        const dateKey = dateTextToSortableKey(subjectDateText);

        if (dateKey === null) continue;

        if (selectedDateKey === null || dateKey > selectedDateKey || (dateKey === selectedDateKey && uid > selectedUid)) {
          selectedUid = uid;
          selectedDateKey = dateKey;
          selectedDateText = subjectDateText;
        }
      }

      candidateUids = [selectedUid];
      if (selectedDateText) {
        console.log(`🆕 Secilen email UID: ${selectedUid} (konu tarihi: ${selectedDateText})`);
      } else {
        console.log(`🆕 Secilen email UID: ${selectedUid} (konu tarihi okunamadi, UID fallback)`);
      }
    }

    let oneOffSent = false;

    for (const uid of candidateUids) {
      if (!oneOffReplayForce && processedIds.has(String(uid))) {
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
        markProcessed(uid);
        continue;
      }

      if (!isExpectedStatementSubject(subject)) {
        console.log(`⏭️  UID ${uid}: hesap ozeti konu formati degil, atlandi.`);
        markProcessed(uid);
        continue;
      }

      if (isNoStatementEmailBody(source)) {
        console.log(`ℹ️  UID ${uid}: gun icinde hareket yok, hesap ozeti uretilmemis.`);
        const statementDate = extractDateFromSubject(subject);
        const dateLabel = statementDate ? formatDateWithWeekday(statementDate) : 'ilgili gun';
        const noTxMessage = [
          '🏦 *Is Bankasi Hesap Hareketi*',
          '',
          `📅 ${dateLabel}`,
          'ℹ️ Bu tarihte hesabiniza gelen herhangi bir para yoktur.'
        ].join('\n');

        await sendWhatsApp(noTxMessage);
        markProcessed(uid);
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
        markProcessed(uid);
        continue;
      }

      console.log(`📄 UID ${uid}: PDF parse ediliyor...`);
      const transactions = await parseIsbankPdf(pdfBuffer);

      if (transactions.length === 0) {
        console.log(`ℹ️  UID ${uid}: PDF'de pozitif gelen islem yok.`);
        const statementDate = extractDateFromSubject(subject);
        const dateLabel = statementDate ? formatDateWithWeekday(statementDate) : formatDateWithWeekday(emailDate);
        const noTxMessage = [
          '🏦 *Is Bankasi Hesap Hareketi*',
          '',
          `📅 ${dateLabel}`,
          'ℹ️ Bu tarihte hesabiniza gelen herhangi bir para yoktur.'
        ].join('\n');

        await sendWhatsApp(noTxMessage);
        markProcessed(uid);
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
      markProcessed(uid);

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
loadProcessedIds();

console.log(`🚀 Bot başladı. Her gün saat 12:00'de Gmail kontrol edilecek.`);

if (isTrue(process.env.STARTUP_CHECK_ENABLED)) {
  console.log('🧪 STARTUP_CHECK_ENABLED=true, acilista bir kez Gmail kontrolu yapiliyor...');
  checkEmails().catch((err) => {
    console.error('❌ Acilis kontrol hatasi:', err.message);
  });
}

// Europe/Istanbul timezone ile direkt 12:00 cron kullan.
cron.schedule('0 12 * * *', () => {
  checkEmails().catch((err) => {
    console.error('❌ Zamanlanmis gorev hatasi:', err.message);
  });
}, {
  timezone: 'Europe/Istanbul'
});
