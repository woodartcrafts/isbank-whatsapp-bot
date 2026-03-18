# isbank-whatsapp-bot

Is Bankasi hesap ozeti e-postalarini (PDF veya mail govdesi) kontrol edip, gelen para hareketlerini WhatsApp grubuna ileten Node.js botu.

Bu README proje icin guncel ve detayli teknik referanstir: kurulum, ortam degiskenleri, calisma akisi, one-off replay, deploy ve sorun giderme.

## 1. Ne Yapar?

Bot her gun `12:00` (Europe/Istanbul) saatinde Gmail kutusunu tarar.

Bulunan uygun Is Bankasi hesap ozeti e-postasi icin:
1. Gonderici ve konu formatini dogrular.
2. "Hesap ozeti uretilmemistir" bilgisini mail govdesinden algilarsa bilgi mesaji yollar.
3. Degilse PDF ekini bulur, parse eder, pozitif (gelen) islemleri cikarir.
4. Sonucu Green API uzerinden WhatsApp grubuna gonderir.

## 2. Guncel Davranis Ozeti

1. Varsayilan modda son 2 gunluk Is Bankasi maillerini arar.
2. Normal modda aday mailler arasindan konu tarihine gore en yeni maili secer.
3. Mail govdesinde "hesap ozeti uretilmemistir" ifadesi varsa, PDF beklemeden "gelen para yok" mesaji gonderir.
4. Bu tespit duz metin, HTML ve quoted-printable kodlu govde varyasyonlari icin desteklenir.
5. PDF varsa, sadece pozitif tutarli satirlari gonderir.
6. Ayni UID'nin tekrar gonderilmesini dosya tabanli kayit ile engeller.

Onemli not:
1. `uids.length === 0` (yani filtreye uyan hic mail bulunamadi) durumunda su an bilgi mesaji gondermez; sadece kontrolu tamamlar.

## 3. Teknoloji ve Mimari

Akis:
1. `node-cron` -> 2. Gmail IMAP (`imapflow`) -> 3. Parse (`pdf-parse`) -> 4. Green API -> 5. WhatsApp grup

Ana bagimliliklar:
1. `imapflow`: Gmail IMAP baglantisi
2. `pdf-parse`: PDF metin cikarma
3. `node-cron`: zamanlama
4. `node-fetch`: Green API HTTP cagrilari
5. `dotenv`: ortam degiskenleri

## 4. Dosya Yapisi

1. `index.js`: tum bot mantigi
2. `package.json`: script ve bagimliliklar
3. `.env.example`: ornek konfigurasyon
4. `processed-ids.json`: islenmis UID kaydi (runtime'da olusur)

## 5. Ortam Degiskenleri

### Zorunlu

1. `GMAIL_USER`: Gmail adresi
2. `GMAIL_APP_PASSWORD`: Gmail App Password (16 karakter)
3. `GREENAPI_INSTANCE`: Green API instance ID
4. `GREENAPI_TOKEN`: Green API token
5. `WHATSAPP_GROUP_ID`: WhatsApp grup ID (`120363...@g.us`)

### Opsiyonel

1. `ISBANK_EMAIL_FROM`: genel gonderici filtresi (varsayilan fallback: `isbank`)
2. `ISBANK_EMAIL_ADDRESS`: tam adres dogrulamasi (onerilen: `bilgilendirme@ileti.isbank.com.tr`)
3. `ONE_OFF_REPLAY_ENABLED`: tek seferlik gecmis tarih yeniden oynatma (`true/false`)
4. `ONE_OFF_REPLAY_DATE`: hedef tarih (`dd.mm.yyyy`)
5. `ONE_OFF_REPLAY_FORCE`: `true` ise daha once islenmis UID tekrar gonderilebilir
6. `ONE_OFF_REPLAY_MAX_AGE_DAYS`: force kapaliysa eski replay tarihini otomatik devre disi birakir
7. `STARTUP_CHECK_ENABLED`: `true` ise acilista bir kez anlik kontrol yapar
8. `PROCESSED_IDS_FILE`: UID dosya yolu (varsayilan: `processed-ids.json`)
9. `PROCESSED_IDS_MAX`: tutulacak maksimum UID sayisi (varsayilan: `1000`)

Notlar:
1. `requireEnv(...)` zorunlu degisken eksikse net hata firlatir.
2. One-off replay sonrasi `ONE_OFF_REPLAY_ENABLED=false` yapilmasi onerilir.

## 6. Cekirdek Isleyis (Adim Adim)

1. Uygulama acilir, islenmis UID listesi diskten yuklenir.
2. Cron `0 12 * * *` (timezone: `Europe/Istanbul`) kurulur.
3. `STARTUP_CHECK_ENABLED=true` ise acilista bir kez `checkEmails()` calisir.
4. IMAP ile INBOX acilir.
5. One-off aktif degilse son 2 gun, aktifse daha genis aralikta mail aranir.
6. Her aday mailde su kontroller yapilir:
  1. Gonderici dogrulama
  2. Konu "tarihli hesap ozeti" dogrulama
7. Govdede "hesap ozeti uretilmemistir" tespit edilirse:
  1. Konu tarihinden gun bilgisi alin
  2. WhatsApp'a "bu tarihte gelen para yoktur" bilgi mesaji gonder
  3. UID'yi islenmis olarak kaydet
8. Aksi halde PDF ek:
  1. Once MIME body structure
  2. Bulunamazsa base64 fallback
9. PDF parse edilir, sadece pozitif islemler secilir.
10. Mesaj Green API ile WhatsApp grubuna gonderilir.
11. UID islenmis listesine eklenir ve diske yazilir.

## 7. Mesaj Formati

Gelen islem varsa:

```text
🏦 *Is Bankasi Hesap Hareketi*
📅 08.03.2026
─────────────────

📥 *+8.470,00 TRY*
📆 06.03.2026
📝 YUSUF MERT KAVAK daire 81
──────────────
```

Hareket yoksa:

```text
🏦 *Is Bankasi Hesap Hareketi*

📅 08.03.2026 Pazar
ℹ️ Bu tarihte hesabiniza gelen herhangi bir para yoktur.
```

## 8. Lokal Calistirma

1. Node.js `18+` kurulu olmali.
2. Klasik kurulum:

```bash
npm install
npm start
```

PowerShell:

```powershell
npm install
npm start
```

## 9. Railway Deploy

1. Repo'yu GitHub'a push et.
2. Railway'de `Deploy from GitHub` ile projeyi bagla.
3. `Variables` sekmesinde tum env degiskenlerini gir.
4. Deploy/restart sonrasi logda su satirlari ara:
  1. `Bot basladi`
  2. `Gmail kontrol ediliyor`
5. Son deploy commitinin beklenen commit oldugunu dogrula.

## 10. Green API Kurulum Ozeti

1. Green API'de instance olustur.
2. QR ile WhatsApp baglantisini tamamla.
3. `idInstance` degerini `GREENAPI_INSTANCE` olarak gir.
4. `apiTokenInstance` degerini `GREENAPI_TOKEN` olarak gir.
5. Grup ID'yi `chatId` olarak yakala ve `WHATSAPP_GROUP_ID` alanina `@g.us` formatinda yaz.

## 11. Son Onemli Guncellemeler

1. Cron saati Istanbul 12:00 olarak sabitlendi.
2. En yeni hesap ozeti secimi konu tarihine gore yapildi.
3. PDF bulma akisina MIME + base64 fallback eklendi.
4. Islenmis UID dedup mekanizmasi kalici dosya ile guclendirildi.
5. Mesaj formatinda tutar gosterimi sadeleştirildi, toplam satiri kaldirildi.
6. Mail govdesindeki "hesap ozeti uretilmemistir" tespiti quoted-printable/HTML encode varyasyonlari icin guclendirildi.

## 12. Bilinen Sinirlar

1. `processed-ids.json` dosya tabanlidir; ephemeral disk senaryosunda sifirlanabilir.
2. PDF parse regex tabanlidir; banka format degisirse guncelleme gerekebilir.
3. Green API plan/instance durumuna bagli limitler olabilir.
4. Hic mail bulunmayan gunlerde otomatik "gelen para yok" mesaji su an gonderilmez.

## 13. Hizli Sorun Giderme

1. `Eksik ortam degiskeni: ...`
  1. Ilgili env Railway Variables'ta bos veya eksik.
2. `WhatsApp gonderilemedi`
  1. `GREENAPI_INSTANCE` ve `GREENAPI_TOKEN` degerlerini kontrol et.
  2. Instance authorize ve online durumda olmali.
  3. `WHATSAPP_GROUP_ID` `@g.us` ile bitmeli.
3. `PDF bulunamadi`
  1. Mail eki farkli MIME yapisinda olabilir.
  2. No-statement maili oldugundan PDF beklenmiyor olabilir.
4. No-transaction mail geldi ama mesaj atilmadiysa
  1. Son surumun deploy edildigini dogrula.
  2. Logda `gun icinde hareket yok, hesap ozeti uretilmemis` satirini ara.
5. One-off replay beklenen tarihi bulmuyorsa
  1. `ONE_OFF_REPLAY_DATE` formatini (`dd.mm.yyyy`) kontrol et.
  2. `ONE_OFF_REPLAY_MAX_AGE_DAYS` ve `ONE_OFF_REPLAY_FORCE` degerlerini kontrol et.

## 14. Guvenlik Notlari

1. `.env` dosyasini repoya commit etme.
2. Token/sifre paylastiysan rotate et.
3. Hassas degerleri sadece Railway Variables gibi guvenli alanlarda tut.

---

Guncel durum: Proje deploy edilmeye ve gunluk otomatik takibe hazir.
