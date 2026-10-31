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

Foydalanuvchi botda `/start` bosganda banner rasm (`assets/start-banner.png`), salom matni va tugmalar chiqadi. Salom matnini va havolalarni admin panelda o'zgartirasiz; matnda `{name}`, `{username}`, `{id}` ishlaydi.

Tugmalar: tepada bitta keng **📱 Ilovani ochish** (mini-ilovani to'g'ridan-to'g'ri ochadi), ostida qolganlari ikkitadan yonma-yon. Qo'llanma havolasi bo'sh bo'lsa o'sha tugma umuman chiqmaydi va pastki qator **Kanal + 🎧 Yordam** bo'ladi — jami 3 ta tugma.

Banner kvadrat (1024×1024). Rasm Telegram'ga faqat **bir marta** yuklanadi — keyin `file_id` ishlatiladi, shuning uchun /start bir zumda javob beradi. Rasmni almashtirish uchun `assets/start-banner.png` ni yangilab deploy qiling: fayl o'zgargani (hajm + vaqt) sezilib, kesh o'zi bekor bo'ladi va yangi rasm bir marta qayta yuklanadi. Qo'lda hech narsa tozalash shart emas.

**Ilova manzili.** /start'dagi «Ilovani ochish» tugmasi **chat pastidagi ko'k «Ilova» tugmasi bilan bir xil manzilni** ishlatadi — server uni Telegram'dan o'zi o'qiydi (har 15 daqiqada va admin panel ochilganda) va faqat u rostdan shu serverga olib borsa qabul qiladi. Ya'ni ko'k tugma ishlayotgan bo'lsa, /start tugmasi ham ishlaydi — hech narsa sozlash shart emas.

Qo'lda belgilash ham mumkin (admin panel → Bot va /start → *Ilova manzili*) — u hammasidan ustun turadi. Mijozlar ilovani qaysi domen orqali ochishini bitta joyda belgilaydi: /start'dagi «Ilovani ochish» tugmasi, chat pastidagi «Ilova» menyu tugmasi va bot ulanishi — hammasi shu manzilga o'tadi. **Tekshirib saqlash** bosilganda server avval o'zini shu manzil orqali tekshiradi (`/api/health`); ochilmaydigan yoki boshqa saytga olib boradigan manzil saqlanmaydi. Railway domeni mavjud bo'lsa, uni bitta tugma bilan tanlash mumkin.

Ilova `ERR_CONNECTION_TIMED_OUT` bilan ochilmasa (domen ba'zi tarmoqlardan ochilmayapti):

1. Railway → service → **Settings → Networking**. `…up.railway.app` domeni bo'lmasa — **Generate Domain**.
2. Brauzerda `https://<o'sha-domen>/api/health` ni oching — `"app":"verion-shop"` chiqishi kerak.
3. Telefonda ilova → Admin panel → **Bot va /start** → **Railway domenini ishlatish** (yoki manzilni yozib **Tekshirib saqlash**).
4. **@BotFather** → `/myapps` → botingiz → **Edit Web App URL** → o'sha manzil. (Bu havolani faqat BotFather o'zgartiradi — referal havolalari `t.me/<bot>/<ilova>` shu orqali ochiladi.)

Domen tuzalgach o'sha joyda qayta `verionshop.uz` ni saqlash mumkin.

**Webhook.** Server Telegram webhook'ini o'zi ulaydi va **har 15 daqiqada tekshirib turadi** — uzilib qolsa o'zi qayta ulaydi. Qo'lda hech narsa sozlash shart emas.

Ilova manzili uch manbadan olinadi, shu tartibda: `PUBLIC_URL` / `RAILWAY_PUBLIC_DOMAIN` o'zgaruvchisi → **admin ilovani ochganda so'rovning `Host` sarlavhasidan o'rganilgan manzil** → yo'q. Ikkinchi manba faqat admin imzosi bilan kelgan so'rovdan olinadi (aks holda kimdir soxta `Host` yuborib webhook'ni o'z domeniga burib yuborardi), va faqat haqiqiy domen + https bo'lsa qabul qilinadi. Ya'ni yangi hostingda ham admin panelni bir marta ochish kifoya.

Botga allaqachon boshqa manzil ulangan bo'lsa, uni jimgina bosib olmaydi — admin paneldagi **Ulanishni qayta qurish** tugmasi majburan ulaydi, va muammo haqida adminlarga bot orqali bir marta xabar boradi. Maxfiy kalit o'zi yaratiladi, shuning uchun soxta "update" yuborib bo'lmaydi.

**Ulanish usuli** (admin panelda: Avto / Webhook / So'rov):

| Usul | Qanday ishlaydi |
|---|---|
| **Webhook** | Telegram BIZGA murojaat qiladi. Tez, lekin domen tashqaridan ochilishi shart. |
| **So'rov (polling)** | Server O'ZI Telegram'dan xabarlarni olib turadi (`getUpdates`). Domen tashqaridan ochilmasa ham ishlaydi. |
| **Avto** (standart) | Avval webhook. Telegram yeta olmasa (masalan `Connection timed out`) — bir daqiqa ichida o'zi so'rov rejimiga o'tadi va bot ishlayveradi. |

Ya'ni domen Telegram uchun yopiq bo'lsa ham bot jim qolmaydi. Domen tuzalgach **Ulanishni qayta qurish** bosilsa yana webhook'ga qaytadi.

**"Start bosmagan ilovaga kirmasin"** (standart holatda yoqilgan). Botni ishga tushirmagan odam ilovada *"Botni ishga tushiring"* ekranini ko'radi: tugma bot chatini ochadi, START bosilgach ekran **o'zi** yopiladi va ilova ochiladi. Bu Telegram'ning "N oylik foydalanuvchi" hisobini oshiradi va bot mijozga xabar (buyurtma, yetkazilgan mahsulot, eslatma) yubora olishini kafolatlaydi.

Bu to'siqni **ko'rmaydiganlar**: ilgari start bosgan eski mijozlar (server buni `sendChatAction` orqali jimgina aniqlaydi — hech qanday xabar chiqmaydi), adminlar, va oddiy brauzerda ochganlar. To'siqni admin paneldagi tugma bilan butunlay o'chirish mumkin.

## O'yinlar do'koni va liniyalar

Bosh sahifa → **O'yinlar** → o'yin (Mobile Legends, PUBG Mobile, Free Fire…) → o'yin sahifasi: Player ID / Server ID, region va bo'lim tugmalari, paketlar (rasm yoki olmos/UC belgisi, HIT / 2x yorliqlari), pastda **Sotib olish**. Balans yetmasa — "Mablag' yetarli emas" jadvali va **To'ldirish** tugmasi. Kiritilgan ID keyingi safar o'zi to'ladi.

Buyurtmada o'yinchi ID'si saqlanadi va kanalga `🎮 Player ID / Server ID: 12345678 (1234)` qatori bilan tushadi. Pul xarid paytida yechiladi; admin **Bekor qilish** bossa — o'zi qaytadi.

**Admin panel → O'yinlar va liniyalar:**

| Bo'lim | Nima qiladi |
|---|---|
| **Narxlar** | O'yinning barcha paketlari bitta ro'yxatda: narx yozing → kalit o'zi yoqiladi → **Saqlash**. Narxi 0 yoki o'chiq paket do'konda ko'rinmaydi. |
| ✏️ (paket) | Nomi, region, bo'lim, belgi, HIT/2x yorlig'i, rasm, qaysi liniyalar to'ldiradi (SKU, tannarx). |
| ✏️ (o'yin) | Nomi, avatar, banner, rang, mijozdan so'raladigan maydonlar va ularning formati, regionlar, bo'limlar. |
| **Liniyalar** | Paketni kim to'ldiradi. Ustuvorlik bo'yicha sinab ko'riladi: biri ishlamasa — keyingisi. |

Boshlang'ich holatda MLBB, PUBG Mobile va Free Fire o'zining standart paketlari bilan qo'shilgan, lekin **narxsiz va o'chiq** — narx yozmaguningizcha do'konda chiqmaydi.

**Liniyalar** (ustuvorlik tartibida sinab ko'riladi):

| # | Liniya | Nima kerak | Qo'shimcha |
|---|---|---|---|
| 1 | **MooGold** | Partner ID, Secret key (MooGold menejeridan) | Katalog va rasm importi, holatni o'zi so'rab turadi |
| 2 | **G2Bulk** | API key (G2Bulk Telegram botidan) | Katalog va rasm importi, holat callback orqali keladi |
| 3 | **Smile.one** | UID, email, merchant key, region (br/ph/…) | **Tekshirish** tugmasi — nikni ko'rsatadi |
| 4–5 | Bo'sh joy | — | Yangi sayt uchun ajratilgan |
| — | **Qo'lda (zaxira)** | — | Hamma sayt rad etsa, buyurtma adminga tushadi |

Sayt liniyalari kalit kiritilmaguncha **o'chiq**. Ulash: admin panel → O'yinlar va liniyalar → liniya ✏️ → kalitlar, kurs (saytdagi 1 birlik = necha so'm) va ustama % → **Saqlash** → **Sinash** (balans ko'rinadi) → **Katalogdan import**: saytdagi o'yinni tanlang, paketlarni belgilang — nomi tozalanadi ("Mobile Legends - 86 Diamonds" → "86 olmos"), narx kurs va ustama bo'yicha hisoblanadi, o'yin rasmi va paket rasmlari saytdan yuklab olinib o'zimizda saqlanadi. Har paketga "Qo'lda" zaxira ham qo'shiladi.

**Pul xavfsizligi qoidalari:**

- Sayt **aniq rad etsa** (balans yetmaydi, ID topilmadi, ulanib bo'lmadi) — keyingi liniya sinab ko'riladi.
- Sayt javobi **tushunarsiz** bo'lsa yoki so'rov yuborilgandan keyin aloqa uzilsa — keyingi liniyaga **o'tilmaydi**: sayt buyurtmani bajargan bo'lishi mumkin va ikkinchi sayt ham to'ldirsa pul ikki marta ketadi. Buyurtma "❓ noaniq" bo'lib qoladi va adminga xabar boradi. Admin saytdan tekshirib "Bajarildi", "Bekor qilish" yoki (buyurtma yaratilmaganini tasdiqlab) "↻ qayta yuborish" bosadi.
- Sayt qabul qilgan buyurtmani qayta yuborib bo'lmaydi.
- Kalit noto'g'ri (HTTP 401) bo'lsa liniya o'zi o'chiriladi — qayta-qayta urinish saytda IP bloklanishiga olib kelishi mumkin.
- MooGold'ga buyurtma ID'miz `partnerOrderId` sifatida yuboriladi — holat shu bo'yicha so'raladi.

**Tekshirilmagan joylar.** Adapterlar ochiq hujjat va kutubxonalar asosida yozilgan va soxta sayt serverlari bilan sinalgan, lekin haqiqiy saytlarga ulanib ko'rilmagan (kalitlar yo'q edi). G2Bulk'ning javob formati hujjatda to'liq ko'rinmadi; Smile.one'ning 200 dan boshqa kodlari ochiq emas — shuning uchun ular tushunarsiz bo'lsa "noaniq" holatga tushadi. Har sayt bilan **birinchi buyurtmani eng arzon paket bilan** qiling va saytdagi natijani solishtiring.

Maxfiy kalitlar admin panelga hech qachon qaytarilmaydi. Tannarx, SKU va liniya ma'lumotlari mijozga yuborilmaydi.

## Admin panel

Admin panel — to'liq ekranli boshqaruv paneli. Unga quyidagi joylardan kiriladi:
- bosh sahifa tepasidagi «Admin» tugmasi;
- profil tepasidagi «Admin panel» qatori;
- do'kon botidagi `/admin` buyrug'i;
- admin botdagi «🛠 Admin panel» tugmasi.

Tepada katta raqamlar turadi: kirim, sotuv, kutilayotgan to'lov va bajarilmagan buyurtma. Ular bugun / hafta / oy / hammasi bo'yicha ko'rinadi, kutilayotganlar bo'lsa qizil rangda chiqadi. Pastda mijoz qidiruvi va barcha bo'limlar katta plitkalar ko'rinishida: Asosiy, Do'kon, Marketing, Sozlamalar. Admin bot hali ulanmagan bo'lsa, panel tepasida token kiritiladigan karta chiqadi.

## Nakrutka liniyalari (SMM panellar)

Nakrutka endi bitta JAP emas, bir nechta SMM panel orqali ishlaydi (`smm.js`). Liniyalar: JustAnotherPanel, Peakerr, SMMKings va 2 ta bo'sh joy, kerak bo'lsa yana qo'shish mumkin. Ko'pchilik SMM panellar bir xil "API v2" ishlatadi, shuning uchun yangi panel ulash uchun **URL va API kalit** yetarli. Sozlash joyi: Admin panel → Nakrutka → Liniyalar → ✏️. U yerda kalit, ustuvorlik, alohida kurs va ustama kiritiladi, «Sinash» tugmasi balans va xizmatlar sonini ko'rsatadi.

- JAP Railway'dagi `JAP_API_KEY` bilan avvalgidek ishlaydi. Uning xizmat ID'lari o'zgarmagan, boshqa panellarniki `liniya:ID` ko'rinishida (masalan `peakerr:1234`).
- «Xizmatlari mijozlarga ko'rinsin» o'chirilsa, panel faqat zaxira bo'lib qoladi.
- **Zaxira:** Xizmatlar ro'yxatida ↪️ tugmasi bilan xizmatga boshqa paneldagi zaxira xizmat biriktiriladi. Asosiy panel aniq rad etsa (balans tugagan, xizmat o'chgan) yoki unga umuman ulanib bo'lmasa, buyurtma zaxiraga ketadi.

**Pul xavfsizligi:**
- Pul panelga yuborishdan oldin yechiladi. Bir vaqtda bosilgan xaridlar balansdan ortiq sarflay olmaydi.
- Hech bir panel qabul qilmasa, pul qaytadi va buyurtma yaratilmaydi.
- Javob tushunarsiz bo'lsa yoki aloqa uzilsa, buyurtma zaxiraga yuborilmaydi va "noaniq" bo'lib qoladi, adminga xabar boradi. Admin panelni tekshiradi va kerak bo'lsa «Bekor qilish» bosadi, pul qaytadi.
- Holat har bir panel bo'yicha avtomatik yangilanadi. Panellar balansi moliya hisobotida ham ko'rinadi.

## AI xizmatlar

Bosh sahifada «AI xizmatlar» bo'limi bor. Unda ChatGPT, Claude, Gemini, Midjourney, Grok, Perplexity va Cursor obunalari turadi. O'yinlar bilan bir xil mexanizmda ishlaydi: paketlar, liniyalar, zaxira, import va rasmlar. Farqi shundaki, mijozdan akkaunt **emaili** so'raladi. Paketlar narxsiz va o'chiq holda qo'shilgan: Admin panel → AI xizmatlar → Narxlar. Narx qo'yilgach do'konda ko'rinadi. Odatda «Qo'lda» liniyasi orqali bajariladi; saytdan import qilganda «＋ Yangi AI xizmat» tanlansa, MooGold yoki G2Bulk katalogidagi obunalar ham ulanadi.

## AI yordamchi (Claude)

Do'kon botiga yozgan mijozga AI o'zi javob beradi (`ai.js`). Mijoz qaysi tilda yozsa — o'zbek, rus yoki ingliz — shu tilda javob oladi.

**AI nima qila oladi:**
- Narxlar va mahsulotlarni do'kon serveridan haqiqiy ma'lumot asosida aytadi.
- O'yin paketi va AI obuna buyurtmasini tayyorlaydi (Player ID yoki emailni so'raydi).
- Mijozning balansi, buyurtma holati va kutilayotgan to'lovlarini ko'rsatadi.
- Ilovaning kerakli bo'limini ochadigan tugma yuboradi (to'ldirish, buyurtmalar, nakrutka, Telegram).
- Hal qila olmasa, suhbatni **operatorga** uzatadi.

**Operatorga uzatish:** admin botga «🙋 Mijoz operatorni so'radi» xabari keladi, unda «✍️ Javob yozish» va «🤖 AI'ga qaytarish» tugmalari bor. Operator rejimida (standart 60 daqiqa) mijoz xabarlari to'g'ridan-to'g'ri adminga boradi.

**Pul xavfsizligi:**
- AI pul yechmaydi. Pul faqat mijoz «✅ Tasdiqlash — N so'm» tugmasini bosganda yechiladi. Xarid ilovadagi bilan bir xil funksiya orqali o'tadi.
- Tugma bir martalik, 15 daqiqa amal qiladi va faqat o'sha mijoz bosa oladi.
- AI chegirma bera olmaydi, pul qaytara olmaydi va balans qo'sha olmaydi: mijoz vositalarida bunday funksiya yo'q.
- Karta raqamini AI yozmaydi.

**Admin botda:** oddiy tilda so'rash mumkin, masalan «bugungi foyda qancha?», «kutilayotgan to'lovlar», «Ali ismli mijoz», «ChatGPT Plus narxini 290 ming qil». Narx yoki balansni o'zgartirish faqat «✅ Ha» tugmasi bosilgandan keyin bajariladi.

**Bepul variant — Gemini:** aistudio.google.com/apikey → «Create API key». Karta kerak emas. Admin panel → ✨ AI yordamchi → «🆓 Gemini» bo'limiga kalitlarni har qatorga bittadan yozing (yoki Railway'da `GEMINI_API_KEYS=k1,k2`). Bepul limit cheklangan, shuning uchun 2–3 ta kalitni **har birini alohida loyihada** yarating: biri limitga (429) yetsa, avtomatik keyingisi ishlatiladi. Standart model — `gemini-3.5-flash-lite`. Vositalar va xavfsizlik qoidalari Claude bilan bir xil.

**Sozlash:** Admin panel → ✨ AI yordamchi. Bu yerda Claude API kaliti (console.anthropic.com, `sk-ant-…`; yoki Railway'da `ANTHROPIC_API_KEY`), model, yoqish/o'chirish, do'kon qoidalari (ish vaqti, yetkazib berish muddati…), kunlik limit va bugungi statistika bor. Standart model — Claude Opus 5.5. Arzonroq variantlar: Sonnet 5.5 yoki Haiku 5.5. API ishlamasa, mijozga support username'i yuboriladi.

## Ilovadagi support chat

Ilovaning har bir ekranida o'ng pastda **🎧 suzuvchi tugma** bor. «Qo'llab-quvvatlash» tugmalari ham shu chatni ochadi. Bosilganda to'liq ekranli chat oynasi ochiladi, mashhur saytlardagi kabi: xabarlar, "yozmoqda…" belgisi, tezkor savollar (Narxlar, MLBB olmos, ChatGPT Plus, buyurtma, to'ldirish, Operator), AI tugmalari («✅ Tasdiqlash», «💳 Balansni to'ldirish»…).

- Avval AI yordamchi javob beradi. Operator chaqirilsa yoki AI o'chiq bo'lsa, xabar admin botga boradi. Operator «✍️ Javob yozish» bilan javob beradi va javob **ham ilova chatida, ham Telegram'da** ko'rinadi.
- Bot va ilova — **bitta suhbat**: botda boshlangan yozishma ilovada ham ko'rinadi (oxirgi 60 ta xabar).
- Chat yopiq paytda yangi javob kelsa, tugmada qizil nuqta chiqadi.

## Operator: faol / band / ish vaqti

AI 24/7 ishlaydi. Operator (admin) esa ish vaqtida javob beradi, standart vaqt 10:00–22:00 (Toshkent). Boshqaruv ikki joyda: admin bot → «👨‍💼 Operator» (yoki `/operator`, `/band`) va mini ilova → AI yordamchi → Operator.

- **Faol:** mijoz operator so'rasa, jonli suhbat boshlanadi, admin «✍️ Javob yozish» orqali javob beradi.
- **Band, o'chiq yoki ish vaqtidan tashqarida:** mijozga «Hozir operator band (faol emas) — sizni navbatga qo'shdim; faol bo'lishi bilan javob beradi (ish vaqti 10:00–22:00)» deyiladi. Shu orada AI muammoni o'zi hal qilishga harakat qiladi. Navbat admin botda turadi, operator javob yozgach mijoz navbatdan chiqadi.

AI'ning bilimlar bazasi do'kon sozlamalaridan avtomatik tuziladi: to'ldirish tartibi va muddati, o'yin ID qayerdan topilishi, AI obunalar, Stars/Premium, nakrutka, qaytarish qoidasi, referal %, sodiqlik darajalari, ish vaqti. Admin panelda yozilgan «qo'shimcha ma'lumot» bularning hammasidan ustun turadi.

## Admin bot (alohida bot) va moliya

Do'kon botidan tashqari **ikkinchi bot** — faqat adminlar uchun (`adminbot.js`). Ulash:

1. Telegram'da @BotFather → `/newbot` → yangi bot oching (do'kon botining tokeni ishlamaydi).
2. Admin panel → **Admin bot** → tokenni qo'ying → «Saqlash va ulash». (Yoki Railway'da `ADMIN_BOT_TOKEN` o'zgaruvchisi.)
3. Har bir admin yangi botga kirib **/start** bosadi.

Botda:
- **🔍 Mijoz** — ID, @username, ism yuboring yoki mijoz xabarini forward qiling. Karta: ID, balans, «N order · xarid · to'ldirilgan», oxirgi orderlar, to'lov slotlari. Tugmalar: ➕ Balans, ➖ Yechish, 🛒 Orderlar, 🎟 Slotlar, 🔄 Yangilash, 🔍 Boshqa, 🌐 Panelda ochish.
- **📊 Moliya** — bugun / hafta / oy / hammasi: kirim (to'lov usullari bo'yicha), sotuv (bo'limlar bo'yicha), qaytarilgan, tannarx va foyda (saytdan bajarilgan o'yin buyurtmalari), qo'lda +/−, mijozlar balansi, kutilayotgan pullar, saytlardagi balans.
- **🧾 To'lovlar**, **🛒 Buyurtmalar** — kutilayotganlar, ✅ / ❌ tugmalari.
- **📩 SMS** — avtomatik tasdiqlash jurnali; mos to'lov topilmagan SMS haqida darhol xabar.
- **⚙️ Holat** — do'kon boti ulanishi, liniyalar, bildirishnomalarni yoqish/o'chirish.

Yangi to'lov («to'ladim» bosilganda) va har bir buyurtma hamma adminlarga keladi; holat o'zgarsa o'sha xabarning o'zi yangilanadi. Pul bilan bog'liq har bir amal ikki bosqichli: ✅ → «Ha». Ikkinchi marta bosilsa pul qayta qo'shilmaydi. ➕ qilinganda mijozga do'kon boti orqali xabar boradi, ➖ da bormaydi. Boshqa adminlar har bir qo'lda o'zgartirishni ko'radi.

Botdagi «Admin panel» tugmasi shu mini ilovani ochadi (`?admin=1`, `?admin=finance`, `?admin=u-<ID>`). Admin bot imzosi bilan ochilgan ilovaga faqat adminlar kira oladi. Mini ilovadagi **Moliya** bo'limi bot bilan bir xil hisobotni ko'rsatadi. Token hech qachon qaytarib ko'rsatilmaydi.

Muhim ogohlantirishlar (liniya xatosi, zaxira tugashi, bot ulanmay qolishi) admin bot orqali keladi; admin botni hali ochmagan adminga ular do'kon boti orqali boradi.

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

## Saytdan hamma o'yinlarni yuklash (qoralama) va do'kon ichida 🔧 tahrirlash

1. Admin panel → O'yinlar va liniyalar → «⬇️ Saytdan HAMMA o'yinlarni yuklash»: liniya, bo'lim, qidiruv va limitni (≤300) tanlang. O'yinlar **qoralama** bo'lib, faqat adminlarga ko'rinadi. Qayta yuklaganda dublikat yaratilmaydi.
2. Do'konning asosiy sahifasida admin barcha o'yinlarni ko'radi. Ular «🔒 Qoralama» yoki «Yashirin» belgisi bilan chiqadi.
3. O'yin sahifasidagi 🔧 o'yinni, paket yonidagi 🔧 esa paketni tahrirlaydi. Saqlagandan keyin do'konga qaytasiz.
4. «🚀 Mijozlarga ochish» o'yinni va narxi bor paketlarni mijozlarga ko'rsatadi.

## Bir xil o'yinlar bitta bo'ladi (regionlar va liniyalar)

- "Mobile Legends (PH)", "MLBB Indonesia" va boshqa shunga o'xshash nomlar bitta **Mobile Legends** o'yiniga birlashadi. Ularning regionlari o'yin sahifasining tepasida tab bo'lib turadi.
- Turli liniyalardagi bir xil paket (masalan, 86 olmos) bitta paket bo'ladi va uning ichida bir nechta liniya bo'ladi. Bitta liniya ishlamasa, buyurtma keyingisiga o'tadi. «Qo'lda» liniyasi doim oxirida turadi.
- O'yinlar O'zbekistonda mashhurligi bo'yicha tartiblanadi: PUBG Mobile, Free Fire, Mobile Legends, Standoff 2 va hokazo. Tartibni admin qo'lda o'zgartirsa, o'sha o'yinning tartibi o'zgarishsiz qoladi.
- Birlashtirish deploy'dan keyin bir marta o'zi ishlaydi. Har bir «Saytdan hammasini yuklash» tugaganida ham ishlaydi. Admin panelda alohida «🔗 Bir xil o'yinlarni birlashtirish» tugmasi ham bor.
- Tayyor narxlar faqat o'yinning asosiy regioniga qo'yiladi. Qolgan regionlarning narxi tannarx × kurs + ustama bo'yicha hisoblanadi.

## Tezlik (ko'p foydalanuvchi uchun)

- **Saqlash:** bazaga faqat o'zgargan qatorlar yoziladi. Eski, yopilgan buyurtma va to'lovlar «sovuq» deb eslab qolinadi va har saqlashda qayta tekshirilmaydi: statusi o'zgarsa darhol yoziladi, status o'zgarmay ichi tahrirlansa aylanma tekshiruv (har saqlashda 1500 qatordan, jimjit paytda har 15 soniyada) uni topib yozadi. Avvalgi «har daqiqada hammasini tekshirish» serverni 1–2 soniya to'xtatib, ping'ni sakratardi. Saqlashlar 400 ms ichida birlashtiriladi, SQLite WAL + `synchronous=NORMAL` rejimida ishlaydi. Server o'chayotganda (SIGTERM yoki SIGINT) hammasi to'liq yoziladi. 150 ms dan uzoq saqlash logda `[db] sekin saqlash` deb ko'rinadi.
- **Node versiyasi:** `package.json`da `22.x` qotirilgan, Railway yangi chiqqan Node'ni o'zicha olib ketmasligi uchun.
- **`/api/me`:** foydalanuvchi bo'yicha indeks ishlatiladi, butun buyurtmalarni aylanib chiqmaydi. Bazaga faqat foydalanuvchi ma'lumoti o'zgargan bo'lsa yoziladi.
- **`/api/leaderboard`:** natija 60 soniya keshlanadi.
- **Ilova:** ochiq turganda 30 soniyada bir yangilanadi, reyting va sharhlar 2 daqiqada bir yangilanadi. Orqa fonda turganda so'rov yubormaydi.
- **O'lchov** (10 ming foydalanuvchi, 50 ming buyurtma, 200 ta parallel mijoz): sekundiga 82 so'rovdan 7900 so'rovgacha. 95% so'rovlarning kechikishi 19 soniyadan 72 ms gacha tushdi.

## Xavfsizlik va barqarorlik (audit, 2026-10-29)

Butun kod qayta o'qib chiqildi va hujumchi sifatida sinab ko'rildi (test skriptlari: hujum to'plami, SMS to'qnashuvi, ikki marta yetkazish, brauzerda XSS). Topilgan va tuzatilganlari:

- **Serverni bitta so'rov bilan qulatish.** `async` handler'dagi xato (masalan tanasi `null` bo'lgan so'rov) butun jarayonni to'xtatardi. Endi har so'rov himoyalangan (`runSafe`): xato faqat o'sha so'rovga 500 beradi; obyekt bo'lmagan tana 400 bilan rad etiladi; server ishga tushgach ushlanmagan xatolar logga yoziladi.
- **Ichki ma'lumot mijozga sizardi.** `/api/me` va xarid javoblarida yetkazib beruvchi (liniya), tannarx, sayt javoblari, admin izohi va admin chat xabar raqamlari bor edi. Endi mijozga faqat ruxsat etilgan maydonlar ketadi (`pubOrder` / `pubPayment`); admin API'lari to'liq ma'lumotni oladi.
- **Bitta buyurtma saytga bir necha marta ketishi.** Admin «qayta yuborish», fon tekshiruvi va callback ustma-ust tushsa, buyurtma bir nechta liniyaga qayta-qayta yuborilardi (sinovda: 1 buyurtma → 6 ta to'lov). Endi har buyurtma uchun qulf bor, fon tekshiruvi ustma-ust ishlamaydi va har javobdan keyin holat qayta tekshiriladi.
- **SMS orqali begona pulni olish.** Bekor qilingan/vaqti tugagan to'lovning aniq summasi endi 1 soat band turadi — kech to'lagan mijozning SMS'i shu summani olgan boshqa odamning to'loviga tushmaydi.
- **Referal suiiste'moli.** Taklif faqat haqiqatan yangi mijozga yoziladi (xaridi va to'ldirishi yo'q), taklif qiluvchi mavjud bo'lishi shart.
- **Buyurtma ID to'qnashuvi.** ID'lar endi kriptografik tasodifiy, 8 belgili va takrorlanmasligi tekshiriladi (avval 6 belgi edi — ko'p buyurtmada ikkitasi bir xil chiqib, bazada biri ikkinchisini o'chirardi).
- **Nakrutka «Partial».** Panel qisman bajarsa, bajarilmagan ulush mijozga qaytariladi; pul qaytgan buyurtma keyin «Completed» bo'lsa — ikki marta pul yo'q, adminga xabar boradi.
- **Telegram so'rovlari kutish chegarasisiz edi** — Telegram javob bermasa bot jim qolardi. Endi hammasida chegara bor. Railway proksisi bilan 502 bo'lmasligi uchun keep-alive 65 s.
- **So'rov tanasi:** oddiy foydalanuvchi uchun 512 KB, admin uchun 10 MB; kirill/emoji katta tanalarda buzilmaydi.
- Katalog, kategoriya rasmlari va ui-emoji bir marta tayyorlanadi (har ochilishda qayta o'qilmaydi); AI suhbatlari 30 kundan keyin tozalanadi; ommaviy xabarlar soniyasiga 20 tadan yuboriladi; rasm yuklashda ichki tarmoq manzillari to'silgan; CSV eksportida formula ishga tushmaydi.

Tekshirilgan va muammo topilmagan: 97 ta admin yo'li (oddiy foydalanuvchi, imzosiz, soxta imzo — hammasi 401/403), begona buyurtma/to'lovga kirish, manfiy/katta summalar, parallel xaridlar va promo-kod, path traversal, webhook kalitlari, mijoz ilovasida XSS (barcha foydalanuvchi matnlari ekranlanadi).

## Steam hamyon va virtual raqam (extra.js)

**Steam hamyon** (O'yinlar → «Steam hamyon» kartasi):
- Mijoz Steam loginini va dollar summasini kiritadi. Tez tugmalar bor: $5, $10, $20, $50, $100. «Qayerdan olaman?» tugmasi kompyuter va telefon uchun yo'riqnomani ochadi.
- Narx = summa × admin kursi (1$ = 13 500 so'm).
- **Ludovex liniyasi yoqilgan bo'lsa**, hamyon avtomatik to'ldiriladi:
  - avval narx so'raladi va tannarx sotuv narxidan oshsa, buyurtma bekor qilinadi (zarar himoyasi);
  - buyurtma `expected_price_usdt` va idempotency kaliti bilan yuboriladi;
  - holati har 20 soniyada tekshiriladi.
- **Ludovex yoqilmagan bo'lsa**, buyurtma adminga qo'lda bajarish uchun keladi.

**Virtual raqam** (Telegram bo'limi → «Virtual raqam»), 5sim.net orqali ishlaydi:
- Mijozga davlatlar ro'yxati, qidiruv va «Ommabop» / «Narx» bo'yicha saralash ko'rinadi. Narx = eng arzon operator narxi × kurs × (1 + ustama).
- Raqam berilgach, SMS kod kutiladi (sukut bo'yicha 20 daqiqa) va kod oynada chiqadi.
- Kod kelmasa yoki mijoz bekor qilsa, raqam 5sim'da bekor qilinadi va pul qaytadi.

**Sozlash:** Admin → «Steam va virtual raqam». U yerda kurs, chegaralar, rejim, 5sim API kaliti va ustama sozlanadi, «Sinash» tugmasi ham bor.

**Xatolar:** sayt puli tugasa, mijozga «keyinroq urinib ko'ring» chiqadi, adminga esa darhol xabar boradi.

## Skinlar do'koni — CS2, Dota 2, Rust (cs2.js, lis-skins.com)

Ilova ichidagi alohida do'kon. Mahsulotlar → O'yinlar bo'limidagi «CS2 skinlar», «Dota 2 skinlar» yoki «Rust skinlar» kartochkasi bosilganda do'kon shu kartochkadan butun ekranga kengayib ochiladi (logotip bilan qisqa animatsiya; «kamroq harakat» sozlamasida animatsiyasiz). Kartochka faqat o'sha o'yin yoqilganda ko'rinadi.

Ko'rinishi ilova mavzusidan qat'i nazar doim to'q: grafit fon, to'r teksturasi, iliq nur va uchqunlar, Unbounded (sarlavhalar) + Inter Tight (matn) shriftlari, o'zimizning sariq-amber urg'u rangi va yashil narxlar. skinsavdo.uz faqat namuna sifatida o'rganilgan — ularning nomi, logotipi, rangi va matnlari olinmagan.

**Do'kon tuzilishi** — o'z sarlavhasi (orqaga, «Verion Skins», balans → to'ldirish, avatar → profil) va pastki menyusi bor:
- **Bosh sahifa:** katta sarlavha «Skinlar so'mda — CS2 / DOTA 2 / RUST» (yoqilgan o'yin nomlari aylanib turadi), «Bozorga o'tish» va trade havola tugmalari, ishonch belgilari, statistika, o'yin plitkalari, «Top skinlar» lentasi, «Yaqinda sotib olindi», «Qanday ishlaydi», Steam hamyon ($5/$10/$20/$50 — Steam sahifasini shu summa bilan ochadi), to'lov usullari, savollar va yakuniy chaqiriq.
- **Bozor:** o'yin tablari (CS2 / Dota 2 / Rust; yopiq o'yin «tez orada»), filtr + qidiruv, tartib, «Trade URL» holati, belgili toifalar qatori, kartochkalar (❤, katta rasm, «…so'mdan», «N ta taklif →»).
- **Skin sahifasi** (o'ngdan suriladi): rasm sahnasi va noyoblik nuri, «Mavjud: N», «O'yinda ko'rish», float oralig'i (CS2), katta nom, noyoblik belgisi, nuqtali jadval (o'yin, qurol/turi, noyoblik, StatTrak™, yetkazish, kafolat), katta yashil narx, «⚡ Sotib olish», «Barcha takliflar»: holat plitkalari (FN/MW/FT/WW/BS — soni va eng arzon narxi) va taklif kartochkalari.
- **Xaridni tasdiqlash** — markazdagi oyna: skin qatori, trade havola (kiritilmagan bo'lsa), JAMI, balans; pul yetmasa «Balansni to'ldirish». Natija oynasi: «Steam'da qabul qilish», «Buyurtmalarim», «Xaridni davom ettirish».
- **Buyurtmalar:** faqat skin xaridlari, holat bo'yicha filtr (Jarayonda / Yetkazildi / Bekor), «Steam'da qabul qilish» tugmasi.
- **Profil:** ism, balans va to'ldirish, statistika (xarid, yetkazildi, sevimli), trade havola, sevimlilar, Steam savdo takliflari, «Qanday ishlaydi?», qo'llab-quvvatlash, asosiy do'konga qaytish.

**O'yinlar bo'yicha farq:**
- **CS2:** toifalar Pichoqlar, Qo'lqoplar, Avtomatlar, Snayperlar, To'pponchalar, PP, Og'ir; toifa ichida qurol turlari; holat, float, StatTrak™/Souvenir, pattern, stikerlar va «O'yinda ko'rish».
- **Dota 2:** toifalar Kiyimlar, Kuryerlar, Wardlar, Sandiqlar, To'plamlar, Taunt, Boshqa; noyoblik (Arcana, Immortal, Legendary…) filtri.
- **Rust:** toifalar Qurollar, Asboblar, Kiyimlar, Jihozlar, Boshqa.
- Sevimlilar o'yin bo'yicha alohida saqlanadi (CS2 — nomi, boshqalar — `o'yin|nomi`).

**Mijoz uchun (umumiy):**
- Filtrlar oynasi: «Faqat sevimlilar», narx oralig'i (so'mda, tez tugmalar bilan), holati (CS2), noyoblik, StatTrak™ / Souvenir / Oddiy va «★ Pichoq va qo'lqoplar» (CS2). Faol filtrlar ro'yxat tepasida ko'rinadi, bosilsa olib tashlanadi.
- «Jonli» toifasi — lis-skins'dagi eng yangi takliflar, darhol «Olish».
- «O'yinda ko'rish» havolasi faqat biz ko'rsatgan taklif uchun ishlaydi: `/api/cs2/inspect?id=` → `steam://run/730/...`.
- Steam trade havola bir marta saqlanadi va uchala o'yin uchun ishlatiladi.
- Xariddan keyin skin Steam'ga trade taklifi bo'lib keladi. Holati do'kondagi va ilovadagi «Buyurtmalar»da skin rasmi bilan ko'rinadi.

**Pul xavfsizligi:**
- Xarid mijoz ko'rgan narx bilan qilinadi: `max_price`. Narx shu orada oshsa, lis-skins sotmaydi va pul qaytadi.
- `custom_id` = buyurtma ID. Bir buyurtma ikki marta sotib olinmaydi.
- Bir taklifni bir vaqtda ikki kishi bossa, faqat bittasi o'tadi.
- Sotilib ketgan bo'lsa, kalit xato bo'lsa, lis-skins hamyonida pul yo'q bo'lsa yoki 4xx javob kelsa, pul darhol qaytadi. Adminga xabar boradi.
- Javob noaniq bo'lsa (aloqa uzilgan yoki 5xx), pul band turadi va holat har daqiqada `custom_id` bo'yicha tekshiriladi:
  - topilsa, buyurtma davom etadi;
  - 15 daqiqada topilmasa, pul qaytadi.
- Trade qabul qilinsa, buyurtma bajarildi (referal va sodiqlik bonusi bilan). Qaytarilsa yoki bekor bo'lsa, pul mijozga qaytadi.
- 2 soatda qabul qilinmasa, mijozga bir marta eslatma boradi.
- Jonli bozor so'rovlari faqat Telegram foydalanuvchisiga ochiq. Limit: daqiqasiga bitta mijozdan 20 ta, jami 150 ta. Natijalar keshlanadi.

**Sozlash (Admin → «Skinlar do'koni»):**
- umumiy yoqish va lis-skins API kaliti (kalit hech qachon qaytib ko'rsatilmaydi);
- kurs (1$ = so'm) va ustama %;
- narx oralig'i ($) va «faqat darhol yuboriladigan skinlar» (trade-lock yo'q);
- har o'yin uchun alohida: «mijozlarga ochiq» (CS2 / Dota 2 / Rust), katalog holati, narxlar ro'yxati havolasi va «Katalogni yangilash». Standart holatda faqat CS2 ochiq.

**Admin tugmalari:**
- «Ulanishni sinash» lis-skins balansi va bitta namuna taklifni ko'rsatadi. Javobni o'qib bo'lmasa, xom javob ham chiqadi.
- «… katalogini yangilash» — har o'yin uchun. Dota 2 / Rust sekin yuklanadi: tugma darhol javob beradi, holat oynada yangilanib turadi.

**Ma'lumot manbalari:**
- CS2 nomlari, rasmlari va toifalari ochiq CS2 bazasidan olinadi (ByMykel/CSGO-API, ~21 ming variant).
- Dota 2 va Rust katalogi Steam bozoridan olinadi (eng ommabop narsalar, sahifalab, Steam cheklovi uchun sekin). Dota 2 noyobligi va toifasi Steam'dagi «type» maydonidan, Rust toifasi nomidan aniqlanadi. Rasmlar faqat `*.steamstatic.com` dan.
- Kataloglar diskda saqlanadi va haftada bir yangilanadi (Dota 2 / Rust — faqat yoqilgan bo'lsa). Yangilash xato bo'lsa, eski katalog qoladi va xato admin panelda ko'rinadi.
- Eng arzon narxlar ro'yxati lis-skins JSON eksportidan olinadi (har o'yinga alohida, 10 daqiqada yangilanadi).
  - Havola admin paneldan kiritiladi: «Narxlar ro'yxati havolasi» — lis-skins hujjatidagi «JSON Price Lists» bo'limidan olinadi.
  - Kiritilmagan bo'lsa, `LIS_PRICES_URL` va bir nechta ma'lum manzil sinab ko'riladi. Har urinish natijasi (HTTP kodi, hajmi, nechta nom o'qilgani) admin panelda ko'rinadi.
  - Ro'yxat bo'lmasa, narxlar API qidiruvi orqali olinadi. Bu holatda filtrlar va «Arzon / Qimmat» tartibi yashiriladi.

lis-skins balansi «🚀 Tayyorlik» va 20 daqiqalik liniya kuzatuviga ulangan.
