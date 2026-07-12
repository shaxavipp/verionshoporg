import os
import base64
import requests
from telethon import TelegramClient, events

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
SESSION_B64 = os.environ.get("SESSION_B64")

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


print("Userbot ishga tushdi. HumoCard/CardXabar xabarlarini kutyapman...")
client.start()
client.run_until_disconnected()
