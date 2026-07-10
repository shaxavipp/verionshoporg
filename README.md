# Verion Shop — Telegram Mini App

Bitta fayl: `verion-shop.html`. Butun do'kon shu faylning ichida (dizayn, mahsulotlar, 3 til, admin panel, to'lov oqimi). Railway'da server bilan ishlaydi (balans, katalog, buyurtmalar serverda).

## Deploy — 1-usul: Railway (tavsiya, banner yo'q)

Repo tarkibi: `verion-shop.html` (ilova), `server.js` (mini-server), `package.json` (Railway shundan Node.js ekanini taniydi), `README.md`. Railway `npm start` ni ishga tushiradi → server HTML'ni beradi.

1. **github.com** da akkaunt oching → **New repository** → nom: `verionshop` → Public → Create.
2. **Add file → Upload files** → 4 ta faylni tashlang (hammasi ildizda tursin) → **Commit changes**.
3. **railway.com** → **Login with GitHub** → ruxsat bering.
4. **New Project → Deploy from GitHub repo** → `verionshop` ni tanlang → Deploy. Build 1-2 daqiqada tugaydi (yashil bo'ladi).
5. Service → **Settings → Networking → Generate Domain** → `xxx.up.railway.app` havolasi chiqadi.
6. Havolani brauzerda tekshiring — Verion Shop splash chiqishi kerak.
7. **@BotFather** → `/mybots` → botingiz → **Bot Settings → Configure Mini App** → shu havolani qo'ying; **Menu Button** URL'ini ham yangilang.

Yangilash: GitHub'da `verion-shop.html` ni almashtirasiz (faylni oching → Edit yoki qayta Upload → Commit) — Railway o'zi qayta deploy qiladi, havola o'zgarmaydi.

Eslatma: Railway bepul rejada oylik limit bor; tugasa sayt to'xtaydi — tiiny.host nusxasini zaxira qilib saqlang.

## Deploy — 2-usul: tiiny.host (eng oddiy)

1. **tiiny.host** → saytingiz → **Update/Replace** → faqat `verion-shop.html` ni yuklang.
2. Havolani brauzerda tekshiring, **@BotFather** dagi Mini App va Menu Button havolasi o'sha bo'lsin.

## Sozlamalar (fayl ichida, tepada `CONFIG` bo'limi)

| Nima | Qator |
|---|---|
| Support | `var SUPPORT_USERNAME="verionshop_support";` |
| Adminlar | `var ADMIN_IDS=[5606872249, 8684274899];` |
| Kartalar | `var CARDS=[...]` (HUMO / UZCARD raqamlari va egasi) |
| Video qo'llanma | `var SHOW_VIDEO_ROW=false;` → link tayyor bo'lganda `true` + `VIDEO_URL` |

O'zgartirgach faylni tiiny.host ga qayta yuklang — havola o'zgarmaydi.

## Admin panel

Profil → **EGASI → Admin panel** (faqat ADMIN_IDS ro'yxatidagi Telegram akkauntlar ko'radi; oddiy brauzerda umuman ko'rinmaydi).

Imkoniyatlar: mahsulot qo'shish/tahrirlash/o'chirish, narx/soni/kategoriya, galereyadan rasm, Aktiv/Noaktiv, jonli ko'rinish.

**Umumiy katalog (Railway'da):** admin panelda o'zgartirish qilib **🌍 Nashr qilish** tugmasini bossangiz, katalog serverga saqlanadi va **barcha mijozlar darhol ko'radi**. Buning ishlashi uchun Railway'da bitta sozlama shart:

1. Railway → service → **Variables** → **New Variable**: nomi `BOT_TOKEN`, qiymati — BotFather bergan bot token (`/mybots` → bot → API Token). Bu server "nashr qilayotgan odam rostdan admin ekanini" Telegram imzosi orqali tekshirishi uchun kerak — tokensiz nashr ishlamaydi (403).
2. Tavsiya: service → **Add Volume** → mount path: `/data` — shunda katalog qayta deploy'da ham saqlanib qoladi. (Volume bo'lmasa: har deploy'dan keyin admin paneldan bir marta qayta Nashr qilasiz.)

Eksport/Import tugmalari zaxira sifatida qoladi. tiiny.host'da esa server yo'q — u yerda katalog faqat shu qurilmada bo'ladi.

## Balans va to'lov tizimi (Stage 1)

Endi balans SERVERDA saqlanadi (har bir Telegram ID uchun). Oqim:

1. Mijoz **To'ldirish** → summa + usul (HUMO/UZCARD) → **Davom etish**.
2. Ilova UNIKAL summa beradi (masalan 50 001 so'm — tanib olish uchun), karta, 10 daqiqalik taymer va qoidalarni ko'rsatadi.
3. Mijoz aynan shu summani o'tkazib **✅ To'lov qildim** ni bosadi.
4. Admin panel → **💰 To'lovlar va mijozlar** da to'lov chiqadi → bank SMS'ni tekshirib **✅** bosiladi → mijoz balansiga avtomatik tushadi.
5. Xarid: mijoz **Sotib olish** → balansdan yechiladi → buyurtma "Yetkazilmoqda" → admin mahsulotni berib **✅** bosadi → holat "Bajarildi". Bekor qilinsa pul avtomatik qaytadi.

Admin panelda mijozni qidirish (ID/@username) va balansga qo'lda +/− qilish ham bor.

Diqqat: bank SMS'dan AVTOMAT o'qish texnik jihatdan web-ilovada mumkin emas — tasdiqlash bir bosishlik qoldi. To'liq avtomat uchun keyinroq Click/Payme merchant yoki Telegram Stars ulanadi.

## Cheklovlar (Phase 2 rejasi)

Keyingi bosqich (Stage 2): interfeys qayta qurish (header, bo'limlar tartibi, O'yinlar, kichik kartochkalar, Dark/Light rejim), referral tizimi, buyurtmalar filtri, keyin Click/Payme/Telegram Stars.

---

*Texnik: vanilla JS, tashqi kutubxonasiz (faqat Telegram WebApp SDK), localStorage, 77 ta avtomatik test o'tgan.*
