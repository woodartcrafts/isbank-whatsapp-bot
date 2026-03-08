# isbank-whatsapp-bot

Is Bankasi'ndan gelen hesap ozeti PDF e-postasini otomatik okuyup, gelen para hareketlerini WhatsApp grubuna ileten Node.js botu.

Bu dokuman projeyi A'dan Z'ye anlatir: mimari, kullanim, kurulum, Railway deploy, degiskenler, isleyis, hata cozumleri ve bu projede yapilan son guncellemeler.

## 1. Proje Ozeti

Sistem her gun saat 12:00'de (Europe/Istanbul) calisir, Gmail'den Is Bankasi e-postalarini kontrol eder, PDF eklentisini parse eder ve gelen para hareketlerini WhatsApp grubuna yollar.

Guncel davranis:
- Son 2 gun icerisindeki filtreye uyan mailleri arar.
- Sadece en son maili (en yuksek UID) isler.
- Islem satirlarinda tarih + pozitif tutar + aciklama bilgilerini gonderir.
- Toplam tutar satiri gondermez.

## 2. Mimari

Akis:
- Railway Scheduler/Runtime -> Gmail IMAP (imapflow) -> PDF Parse (pdf-parse) -> Green API -> WhatsApp Grubu

Bilesenler:
- `Node.js >= 18`
- `imapflow`: Gmail IMAP baglantisi ve e-posta tarama
- `pdf-parse`: PDF'ten metin cikarma
- `node-cron`: Gunluk zamanlama
- `node-fetch`: Green API HTTP istekleri
- `dotenv`: Ortam degiskenleri
- `Railway`: Cloud calisma ortami
- `Green API`: WhatsApp mesaji gonderme

## 3. Dosya Yapisi

- `index.js`: Ana uygulama
- `package.json`: Bagimliliklar ve scripts
- `.env.example`: Ornek ortam degiskenleri
- `.gitignore`: Gizli/veri dosyalarini commit disi birakir

## 4. Ortam Degiskenleri

Zorunlu degiskenler:
- `GMAIL_USER`: Gmail adresi
- `GMAIL_APP_PASSWORD`: Google App Password (16 karakter)
- `GREENAPI_INSTANCE`: Green API instance ID
- `GREENAPI_TOKEN`: Green API token
- `WHATSAPP_GROUP_ID`: Grup ID (`120363...@g.us`)

Opsiyonel:
- `ISBANK_EMAIL_FROM`: Gonderici filtresi (varsayilan: `isbank`)
- `ISBANK_EMAIL_ADDRESS`: Tam gonderici adresi (onerilen: `bilgilendirme@ileti.isbank.com.tr`)

Not:
- Koddaki `requireEnv(...)` zorunlu degisken bos/eksikse log'a net hata yazar.

## 5. Uygulama Isleyisi (Adim Adim)

1. Uygulama baslar.
2. `node-cron` ile her gun saat 12:00'de job tetiklenir.
3. Ek olarak servis acilisinda bir kez `checkEmails()` calisir.
4. Gmail IMAP baglantisi acilir.
5. Son 2 gun + `from` filtresi ile e-postalar aranir.
6. Gonderici adresi ve konu satiri hesap ozeti formatina gore dogrulanir.
7. "hesap ozeti uretilmemistir" icerigi varsa e-posta bilgi maili olarak atlanir.
8. Bulunan UID'lerden sadece en yeni UID secilir.
9. Mail govdesinden PDF eki once MIME body structure ile, olmazsa base64 fallback ile alinmaya calisilir.
10. PDF satir satir parse edilir.
11. Tarih + pozitif tutar satirlari secilir.
12. Aciklamalardan teknik artefaktlar temizlenir (`Sube`, `*0015*`, `FAST` vb.).
13. WhatsApp mesaji olusturulur:
   - `📥 tutar`
   - `📆 tarih`
   - `📝 aciklama`
14. Green API `sendMessage` ile gruba gonderilir.
15. Islenen UID memory'de tutulur (aynisi ayni runtime'da tekrar gonderilmez).

## 6. Mesaj Formati

Ornek cikti:

```text
🏦 *Is Bankasi Hesap Hareketi*
📅 08.03.2026
─────────────────

📥 *+8.470,00 TRY*
📆 06.03.2026
📝 YUSUF MERT KAVAK daire 81
──────────────
```

Not:
- Toplam tutar satiri kaldirildi (kullanici talebi).

## 7. Lokal Kurulum

```bash
npm install
npm start
```

Windows PowerShell:

```powershell
npm install
npm start
```

## 8. Railway Deploy

1. Repo'yu GitHub'a push et.
2. Railway'de `Deploy from GitHub` ile bagla.
3. `Variables` sekmesinde tum env'leri gir.
4. Deploy/Restart yap.
5. Runtime log'da kontrol et:
   - `Bot basladi...`
   - `Gmail kontrol ediliyor...`

## 9. Green API Kurulum Ozeti

1. Green API'de instance olustur.
2. WhatsApp QR baglantisini tamamla.
3. `idInstance` -> `GREENAPI_INSTANCE`
4. `apiTokenInstance` -> `GREENAPI_TOKEN`
5. Grup ID'yi API notifications veya chat verisinden al:
   - Format: `120363...@g.us`

Bu projede kullanilan grup ID ornegi:
- `120363258492842198@g.us`

## 10. Bu Projede Yapilan Onemli Guncellemeler

1. Cron saati `Europe/Istanbul` icin 12:00 olacak sekilde duzeltildi.
2. Acilista da bir kez kontrol eklenerek restart sonrasi gun kacirma riski azaltildi.
3. Green API, Gmail env degiskenleri icin zorunlu kontrol eklendi.
4. Eksik env durumunda servis coker yerine kontrollu hata logu verilecek sekilde dayaniklilik artirildi.
5. PDF ek alma akisi guclendirildi:
   - Once MIME body structure
   - Sonra base64 fallback
6. Mesaj ve log formatinda cift `+` sorunu giderildi.
7. Aciklama temizligi iyilestirildi (`Sube`, `*kod*`, `FAST` artefaktlari).
8. Mesajdan toplam tutar kaldirildi.
9. Sadece en son email isleme mantigi eklendi.
10. `.gitignore` guclendirildi (`.env`, `env`, `node_modules`, excel/temp dosyalari).

## 11. Bilinen Sinirlar

1. Islenen UID'ler su an memory'de tutulur.
   - Servis yeniden baslarsa bu liste sifirlanir.
2. PDF parse regex tabanli oldugu icin banka format degisirse guncelleme gerekebilir.
3. Green API ucretsiz planda kisitlar olabilir.

## 12. Onerilen Sonraki Iyilestirmeler

1. Kalici dedup store (Redis/Postgres) ile restart sonrasi tekrar gonderim riskini sifirlama.
2. Gelismis mail filtreleme (`from + subject + attachment mime`) ile daha saglam secim.
3. Parse testleri (ornek PDF fixture) ekleme.
4. Basarisiz istekler icin retry/backoff.
5. Log ve alarm mekanizmasi (Railway + webhook/monitoring).

## 13. Guvenlik Notlari

1. `.env` dosyasini asla repo'ya koyma.
2. Paylasilan token/sifreleri yenile.
3. Railway `Variables` disinda kimlik bilgisi saklama.

## 14. Hizli Sorun Giderme

- `Eksik ortam degiskeni: ...`
  - Ilgili variable Railway'de eksik veya bos.

- `PDF bulunamadi`
  - Mailde PDF yok veya MIME yapisi farkli.

- WhatsApp'a gitmiyor
  - Instance authorize mi?
  - `WHATSAPP_GROUP_ID` `@g.us` formatinda mi?
  - Token/instance dogru mu?

- Grup ID bulunamiyor
  - `ReceiveIncomingNotifications` ile gelen event JSON'unda `chatId` yakala.

---

Guncel durum: Proje aktif olarak deploy edilebilir ve gunluk otomasyon akisina hazirdir.
