import os
import base64
import time
import signal
import asyncio
import requests
from telethon import TelegramClient, events
from telethon.errors import AuthKeyDuplicatedError

API_ID = int(os.environ["TG_API_ID"])
API_HASH = os.environ["TG_API_HASH"]
SERVER_URL = os.environ.get("SERVER_URL", "https://verionshoporg-production.up.railway.app/api/sms-webhook")
SMS_SECRET = os.environ["SMS_SECRET"]
WATCH_USERNAMES = set(
    u.strip().lower()
    for u in os.environ.get("WATCH_USERNAMES", "humocardbot,cardxabarbot").split(",")
    if u.strip()
)

SESSION_FILE = "verionshop_userbot.session"
SESSION_B64 = (os.environ.get("SESSION_B64_PART1", "") + os.environ.get("SESSION_B64_PART2", "")) or os.environ.get("SESSION_B64")

if SESSION_B64 and not os.path.exists(SESSION_FILE):
    with open(SESSION_FILE, "wb") as f:
        f.write(base64.b64decode(SESSION_B64))
    print("Session fayl SESSION_B64'dan tiklandi.")

client = TelegramClient(SESSION_FILE.replace(".session", ""), API_ID, API_HASH)


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


# ---- Railway qayta deploy qilganda avval eski nusxaga "to'xta" (SIGTERM) signali yuboradi,
# so'ng yangi nusxani ishga tushiradi. Agar eski nusxa shu signalni e'tiborsiz qoldirsa,
# u Telegram bilan ulanishni "yopilmagan" holda tashlab ketadi va yangi nusxa ulanganda
# ikkovi bir lahza to'qnashib, aynan AuthKeyDuplicatedError xatosini beradi.
# Shu funksiya signalni ushlab, ulanishni to'g'ri yopib, keyin dasturni tugatadi.
shutting_down = False

def _graceful_shutdown(signame):
    global shutting_down
    if shutting_down:
        return
    shutting_down = True
    print(f"{signame} signali qabul qilindi — ulanishni toza yopyapman...")
    loop = asyncio.get_event_loop()
    loop.create_task(_disconnect_and_exit())

async def _disconnect_and_exit():
    try:
        if client.is_connected():
            await client.disconnect()
        print("Ulanish toza yopildi. Chiqilmoqda.")
    finally:
        os._exit(0)


# ---- Qayta ulanish: Telegram "AuthKeyDuplicatedError" bersa, darhol qayta
# urinmasdan kutamiz — chunki juda tez qayta ulanish yana xuddi shu xatoni
# keltirib chiqaradi (eski ulanish hali "o'lik" deb belgilanmagan bo'ladi).
# Har muvaffaqiyatsiz urinishdan keyin kutish vaqti oshib boradi (max 5 daqiqa).
async def main():
    loop = asyncio.get_event_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, lambda s=sig: _graceful_shutdown(s.name))
        except NotImplementedError:
            pass  # Windows kabi ba'zi muhitlarda qo'llab-quvvatlanmasligi mumkin

    delay = 15
    while True:
        try:
            print("Userbot ishga tushmoqda...")
            await client.start()
            print("Userbot ishga tushdi. HumoCard/CardXabar xabarlarini kutyapman...")
            delay = 15  # muvaffaqiyatli ulanishdan keyin kutish vaqtini asliga qaytaramiz
            await client.run_until_disconnected()
        except AuthKeyDuplicatedError:
            print(f"AuthKeyDuplicatedError: session boshqa joyda ham faol. {delay}s kutamiz va qayta urinamiz...")
        except Exception as e:
            print(f"Kutilmagan xato: {e}. {delay}s kutamiz va qayta urinamiz...")
        finally:
            try:
                if client.is_connected():
                    await client.disconnect()
            except Exception:
                pass

        await asyncio.sleep(delay)
        delay = min(delay * 2, 300)  # exponential backoff, 5 daqiqadan oshmaydi


if __name__ == "__main__":
    asyncio.run(main())
