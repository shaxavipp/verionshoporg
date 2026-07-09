# Verion Shop — Telegram Mini App

Bitta fayl: `verion-shop.html`. Butun do'kon shu faylning ichida (dizayn, mahsulotlar, 3 til, admin panel, to'lov oqimi). Server kerak emas.

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

## To'lov oqimi

1. Mijoz mahsulotni tanlaydi → **Sotib olish** → buyurtma (VN-XXXXXX) yaratiladi.
2. To'lov ekrani: HUMO yoki UZCARD → karta raqami + aniq summa ko'rsatiladi.
3. Mijoz pulni o'tkazadi → **Chek yuborish** → @verionshop_support chati Buyurtma ID bilan ochiladi → mijoz chek skrinshotini yuboradi.
4. Admin pulni tekshiradi va mahsulotni chatda beradi.

Balans/hamyon YO'Q — har buyurtma alohida to'lanadi (serversiz hamyonni xavfsiz qilib bo'lmaydi).

## Cheklovlar (Phase 2 rejasi)

Server qo'shilganda: umumiy katalog (admin qo'shsa hammaga darhol ko'rinadi), rasmlar serverda, buyurtmalarni admin panelda tasdiqlash, balans tizimi, promo-kodlar, referral, Click/Payme/Telegram Stars.

---

*Texnik: vanilla JS, tashqi kutubxonasiz (faqat Telegram WebApp SDK), localStorage, 33 ta avtomatik test o'tgan.*
