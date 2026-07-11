# Userbot: sizning shaxsiy Telegram akkountingiz nomidan ishlaydi (bot emas!).
# HumoCard/CardXabar'dan kelgan xabarlarni o'qib, serveringizga yuboradi.
#
# ORNATISH:
#   pip install telethon requests
#
# KERAKLI MA'LUMOTLAR (bir martalik, bepul):
#   1. https://my.telegram.org ga kiring (o'z telefon raqamingiz bilan)
#   2. "API development tools" -> yangi ilova yarating (nomi/tavsif ixtiyoriy)
#   3. api_id va api_hash ni oling, pastga qo'ying
#
# BIRINCHI ISHGA TUSHIRISHDA:
#   - Telefon raqamingizni so'raydi
#   - Telegram'dan kelgan kodni so'raydi (SMS emas, ilovaning o'zida keladi)
#   - Shundan keyin session fayl saqlanadi, qayta so'ramaydi

import re
import requests
from telethon import TelegramClient, events

# ============ SOZLAMALAR — shu joyларни to'ldiring ============
API_ID = 39890698                           # my.telegram.org dan
API_HASH = "5016d26ec75fabe48880db4f808e4379"  # my.telegram.org dan
SERVER_URL = "https://verionshoporg-production.up.railway.app/api/sms-webhook"
SMS_SECRET = "mening_parolim123"            # Railway'dagi TG_WEBHOOK_SECRET bilan BIR XIL bo'lishi shart
# Faqat shu botlardan kelgan xabarlarni tinglaymiz (kichik harf, @ belgisisiz):
WATCH_USERNAMES = {"humocardbot", "cardxabarbot"}
# ================================================================

client = TelegramClient("verionshop_userbot", API_ID, API_HASH)


@client.on(events.NewMessage(incoming=True))
async def handler(event):
    sender = await event.get_sender()
    uname = (getattr(sender, "username", "") or "").lower()
    if uname not in WATCH_USERNAMES:
        return

    text = event.raw_text or ""
    print(f"[{uname}] xabar keldi: {text[:120]}")

    try:
        r = requests.post(
            SERVER_URL,
            json={"text": text, "from": uname},
            headers={"x-sms-secret": SMS_SECRET},
            timeout=10,
        )
        print("Serverga yuborildi, javob:", r.status_code, r.text[:200])
    except Exception as e:
        print("Serverga yuborishda xato:", e)


print("Userbot ishga tushdi. HumoCard/CardXabar xabarlarini kutyapman...")
client.start()
client.run_until_disconnected()
