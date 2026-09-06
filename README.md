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

**Kim admin ekanini SERVER hal qiladi** (`/api/me` → `isAdmin`). Ya'ni Railway'dagi `ADMIN_IDS` (yoki u bo'lmasa `server.js` dagi standart ro'yxat) ustun turadi — HTML ichidagi `var ADMIN_IDS=[...]` faqat internet/server javobi kelgunicha zaxira. Shu sababli ikkala ro'yxat bir-biriga to'g'ri kelmay qolsa ham admin panel ochilaveradi.

**Admin panel ochilmasa** — Profil ekranida ismingiz ostidagi kichik satrga qarang: `v2026-09-05.1 · srv 2026-09-05.1`. Birinchisi — Telegram ko'rsatayotgan HTML, ikkinchisi — Railway'dagi server.

| Ko'rinish | Ma'nosi | Yechim |
|---|---|---|
| Ikkalasi bir xil | Kod yangi, muammo ID da | `ID:` raqamingiz ro'yxatda bormi tekshiring |
| `srv` raqami eski | Railway hali deploy qilmagan | Railway → Deployments → **Redeploy** |
| `srv` ko'rinmaydi | Server javob bermayapti | Railway loglarini ko'ring |
| `v` raqami eski | Telegram eski HTML'ni keshdan beryapti | Mini App'ni butunlay yopib qayta oching |

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

## Bot: /start xabari va "start majburiy"

Admin panel → **Bot va /start**.

Foydalanuvchi botda `/start` bosganda banner rasm (`assets/start-banner.png`), salom matni va tugmalar chiqadi: **📱 Ilovani ochish** (mini-ilovani to'g'ridan-to'g'ri ochadi), **Kanal**, **Qo'llanma**, **🎧 Yordam**. Salom matnini va havolalarni admin panelda o'zgartirasiz; matnda `{name}`, `{username}`, `{id}` ishlaydi.

Banner rasm Telegram'ga faqat **bir marta** yuklanadi — keyin `file_id` ishlatiladi, shuning uchun /start bir zumda javob beradi. Rasmni almashtirsangiz, `assets/start-banner.png` ni yangilab deploy qiling (yangi file_id o'zi olinadi).

**Webhook.** Server ishga tushganda Telegram webhook'ini o'zi ulaydi — Railway'da qo'lda hech narsa sozlash shart emas (`RAILWAY_PUBLIC_DOMAIN` avtomatik o'qiladi; boshqa hostingda `PUBLIC_URL` o'zgaruvchisini qo'shing). Botga allaqachon boshqa manzil ulangan bo'lsa, uni jimgina bosib olmaydi — admin paneldagi **Webhookni qayta ulash** tugmasi majburan ulaydi. Maxfiy kalit o'zi yaratiladi, shuning uchun soxta "update" yuborib bo'lmaydi.

**"Start bosmagan ilovaga kirmasin"** (standart holatda yoqilgan). Botni ishga tushirmagan odam ilovada *"Botni ishga tushiring"* ekranini ko'radi: tugma bot chatini ochadi, START bosilgach ekran **o'zi** yopiladi va ilova ochiladi. Bu Telegram'ning "N oylik foydalanuvchi" hisobini oshiradi va bot mijozga xabar (buyurtma, yetkazilgan mahsulot, eslatma) yubora olishini kafolatlaydi.

Bu to'siqni **ko'rmaydiganlar**: ilgari start bosgan eski mijozlar (server buni `sendChatAction` orqali jimgina aniqlaydi — hech qanday xabar chiqmaydi), adminlar, va oddiy brauzerda ochganlar. To'siqni admin paneldagi tugma bilan butunlay o'chirish mumkin.

## Kanallar — qaysi xabar qayerga tushadi

Admin panel → **Kanallar (chat_id)**. Uchta mustaqil kanal:

| Xabar | Nima ketadi |
|---|---|
| 🛍 **Buyurtmalar** | Har bir yangi buyurtma va uning holati (#226, Muvaffaqiyatli/Bekor qilindi) |
| 💳 **To'lovlar** | Balansni to'ldirish so'rovlari (bitta xabar tahrirlanib boradi: Kutilmoqda → Tasdiqlandi) |
| 🔑 **Yetkazilganlar** | Sotilgan mahsulot nusxasi (login/parol, link) — nizo chiqqanda dalil sifatida |

chat_id — kanalning **raqamli** ID si (masalan `-1001234567890`), `@username` emas. Bot o'sha kanalda **admin** bo'lishi shart. Har birining yonida **Sinov xabari yuborish** tugmasi bor — bosib ko'rsangiz, kanal to'g'ri yoki Telegram xatosi (masalan "bot kanalda admin emas") darhol chiqadi.

Bo'sh qoldirilgan kanal — o'sha turdagi xabar hech qayerga yuborilmaydi (mijozga baribir boradi). Yagona istisno: **Yetkazilganlar** bo'sh bo'lsa, buyurtmalar kanaliga yoziladi.

Railway'dagi `ORDER_NOTIFY_CHAT_ID` / `TOPUP_NOTIFY_CHAT_ID` / `DELIVERY_LOG_CHAT_ID` o'zgaruvchilari faqat **birinchi ishga tushish** uchun standart qiymat bo'lib qoldi. Undan keyin admin paneldagi qiymat ustun turadi — kanalni almashtirish uchun qayta deploy kerak emas.

## Cheklovlar (Phase 2 rejasi)

Keyingi bosqich (Stage 2): interfeys qayta qurish (header, bo'limlar tartibi, O'yinlar, kichik kartochkalar, Dark/Light rejim), referral tizimi, buyurtmalar filtri, keyin Click/Payme/Telegram Stars.

---

*Texnik: vanilla JS, tashqi kutubxonasiz (faqat Telegram WebApp SDK), localStorage, 77 ta avtomatik test o'tgan.*
